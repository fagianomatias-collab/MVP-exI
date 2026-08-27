/**
 * Exponential Imagination — video generation backend
 * ----------------------------------------------------
 * Holds the xAI API key server-side (never exposed to the browser) and:
 *   1. Accepts a set of scenes from the front-end.
 *   2. Builds two video-generation prompts per scene (8 total for 4 scenes),
 *      each describing a ~14 second clip.
 *   3. Calls xAI's video generation endpoint for each prompt and polls until
 *      each clip is ready.
 *   4. Downloads all clips and concatenates them (in scene order) into a
 *      single final video using ffmpeg.
 *   5. Exposes a simple job-status endpoint so the front-end can show
 *      progress: "prompts created" -> "sent for AI generation" ->
 *      "creating final video" -> done (with a playable video URL).
 *
 * IMPORTANT — before running this:
 *   - Rotate/revoke any previously exposed xAI API key. Get a new one at
 *     https://console.x.ai/team/default/api-keys
 *   - Copy .env.example to .env and fill in XAI_API_KEY with the NEW key.
 *   - `npm install` then `npm start`.
 *   - Verify the request/response field names below against the current
 *     xAI docs (https://docs.x.ai/developers/rest-api-reference/inference/videos)
 *     before relying on this in production — API surfaces evolve.
 */

require('dotenv').config({ path: require('path').join(__dirname, 'x.env') });

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const {
  XAI_API_KEY,
  ANTHROPIC_API_KEY,
  ANTHROPIC_WORKSPACE_ID,
  PORT = 3001,
  XAI_VIDEO_MODEL = 'grok-imagine-video',
  XAI_VIDEO_RESOLUTION = '480p',
  XAI_VIDEO_DURATION = '14',
  ALLOWED_ORIGINS = '*',
  POLL_INTERVAL_MS = '5000',
  POLL_TIMEOUT_MS = '300000'
} = process.env;

if (!XAI_API_KEY) {
  console.error('Missing XAI_API_KEY. Set it in x.env (local) or your host\'s environment variables.');
  process.exit(1);
}

if (!ANTHROPIC_API_KEY) {
  console.warn('Missing ANTHROPIC_API_KEY — /api/generate (text generation) will not work until this is set.');
}
if (ANTHROPIC_API_KEY && !ANTHROPIC_WORKSPACE_ID) {
  console.warn('ANTHROPIC_WORKSPACE_ID is not set. If your key is an "identity-linked" key, Anthropic will reject requests with: "anthropic-workspace-id is required...". Set ANTHROPIC_WORKSPACE_ID if you hit that error.');
}

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

const XAI_BASE_URL = 'https://api.x.ai/v1';
const POLL_INTERVAL = parseInt(POLL_INTERVAL_MS, 10);
const POLL_TIMEOUT = parseInt(POLL_TIMEOUT_MS, 10);
const CLIP_DURATION = parseInt(XAI_VIDEO_DURATION, 10);

const TMP_DIR = path.join(__dirname, 'tmp');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// In-memory job store. Fine for a single-instance/demo deployment. For
// production, back this with a real datastore (Redis, a database, etc.)
// so jobs survive restarts and work across multiple server instances.
// ---------------------------------------------------------------------------
const jobs = new Map();

function createJob() {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'starting', // starting -> prompts_created -> generating -> combining -> done -> error
    progress: { completedClips: 0, totalClips: 0 },
    prompts: [],
    videoUrl: null,
    error: null,
    createdAt: Date.now()
  };
  jobs.set(id, job);
  return job;
}

function publicJobView(job) {
  // Don't leak internal file paths etc. to the client.
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    videoUrl: job.videoUrl,
    error: job.error
  };
}

// ---------------------------------------------------------------------------
// Prompt building: 2 prompts per scene, each targeting a ~14s clip that
// together cover the scene's ~30 seconds of action.
// ---------------------------------------------------------------------------
function buildPromptsForScenes(scenes) {
  const prompts = [];
  scenes.forEach((scene, sceneIndex) => {
    const dialogueLines = String(scene.dialogue || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const mid = Math.ceil(dialogueLines.length / 2);
    const firstHalfDialogue = dialogueLines.slice(0, mid).join('\n');
    const secondHalfDialogue = dialogueLines.slice(mid).join('\n');

    const context = `Location: ${scene.location || 'unspecified'}. Characters present: ${scene.characters || 'unspecified'}.`;

    const part1 = [
      `Generate a ${CLIP_DURATION}-second video clip.`,
      context,
      `Depict the first half of this scene: ${scene.description || ''}`,
      firstHalfDialogue ? `Include this dialogue, spoken naturally and in sync with the characters' lip movement: ${firstHalfDialogue}` : '',
      'Establish the setting and characters clearly. Return the finished video.'
    ].filter(Boolean).join(' ');

    const part2 = [
      `Generate a ${CLIP_DURATION}-second video clip that continues directly from the previous clip, with no time skip.`,
      context,
      `Depict the second half of this scene: ${scene.description || ''}`,
      secondHalfDialogue ? `Include this dialogue, spoken naturally and in sync with the characters' lip movement: ${secondHalfDialogue}` : '',
      'Maintain the same setting, characters, and visual style as the prior clip. Return the finished video.'
    ].filter(Boolean).join(' ');

    prompts.push({ sceneIndex, part: 1, title: scene.title || `Scene ${sceneIndex + 1}`, prompt: part1 });
    prompts.push({ sceneIndex, part: 2, title: scene.title || `Scene ${sceneIndex + 1}`, prompt: part2 });
  });
  return prompts;
}

// ---------------------------------------------------------------------------
// xAI calls
// ---------------------------------------------------------------------------
async function startVideoGeneration(promptText) {
  const res = await fetch(`${XAI_BASE_URL}/videos/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: XAI_VIDEO_MODEL,
      prompt: promptText,
      duration: CLIP_DURATION,
      resolution: XAI_VIDEO_RESOLUTION
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && data.error && (data.error.message || data.error)) || `xAI request failed (HTTP ${res.status})`);
  }
  if (!data.request_id) {
    throw new Error('xAI response did not include a request_id');
  }
  return data.request_id;
}

async function pollVideoResult(requestId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT) {
    const res = await fetch(`${XAI_BASE_URL}/videos/${requestId}`, {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data && data.error && (data.error.message || data.error)) || `xAI status check failed (HTTP ${res.status})`);
    }
    // Per xAI docs: { status: "done", video: { url, duration, ... }, progress }
    if (data.status === 'done' && data.video && data.video.url) {
      return data.video.url;
    }
    if (data.status === 'failed' || data.status === 'error') {
      const reason = (data.error && (data.error.message || data.error)) || data.reason || data.message || 'no reason provided by xAI';
      throw new Error(`xAI reported the video generation failed: ${reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
  throw new Error('Timed out waiting for a video clip to finish generating');
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download clip (HTTP ${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buffer);
}

// ---------------------------------------------------------------------------
// ffmpeg concatenation. Re-encodes each clip to a consistent format before
// joining, since AI-generated clips may not share identical codecs/resolution
// — the concat *filter* (not the faster concat demuxer) handles that safely.
// ---------------------------------------------------------------------------
function concatenateClips(clipPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    clipPaths.forEach((clipPath) => command.input(clipPath));

    const filterInputs = clipPaths.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
    const filterComplex = `${filterInputs}concat=n=${clipPaths.length}:v=1:a=1[outv][outa]`;

    command
      .complexFilter(filterComplex)
      .outputOptions(['-map [outv]', '-map [outa]'])
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-preset veryfast', '-crf 28']) // lower quality/bitrate = smaller, faster — matches "low resolution" request
      .on('error', reject)
      .on('end', resolve)
      .save(outputPath);
  });
}

// ---------------------------------------------------------------------------
// Job processing pipeline
// ---------------------------------------------------------------------------
async function processJob(job, scenes) {
  const jobTmpDir = path.join(TMP_DIR, job.id);
  try {
    await fsp.mkdir(jobTmpDir, { recursive: true });

    // Step 1: build prompts
    const prompts = buildPromptsForScenes(scenes);
    job.prompts = prompts;
    job.progress.totalClips = prompts.length;
    job.status = 'prompts_created';

    // Step 2: generate each clip sequentially (safer for rate limits than
    // firing all 8 at once; increase concurrency later if your plan allows it)
    job.status = 'generating';
    const clipPaths = [];
    for (let i = 0; i < prompts.length; i++) {
      const clipLabel = `Scene ${prompts[i].sceneIndex + 1}, part ${prompts[i].part} (clip ${i + 1} of ${prompts.length})`;
      let requestId, videoUrl;
      try {
        requestId = await startVideoGeneration(prompts[i].prompt);
        videoUrl = await pollVideoResult(requestId);
      } catch (clipErr) {
        throw new Error(`${clipLabel} failed: ${clipErr.message}`);
      }
      const clipPath = path.join(jobTmpDir, `clip-${String(i).padStart(2, '0')}.mp4`);
      await downloadFile(videoUrl, clipPath);
      clipPaths.push(clipPath);
      job.progress.completedClips = i + 1;
    }

    // Step 3: combine into one final video
    job.status = 'combining';
    const outputPath = path.join(OUTPUTS_DIR, `${job.id}.mp4`);
    await concatenateClips(clipPaths, outputPath);

    job.videoUrl = `/outputs/${job.id}.mp4`;
    job.status = 'done';
  } catch (err) {
    job.status = 'error';
    job.error = err && err.message ? err.message : 'Unknown error generating the movie';
  } finally {
    // Clean up per-job temp clips regardless of outcome
    fsp.rm(jobTmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
const app = express();

// CORS must be registered before body parsing: if JSON parsing throws,
// Express skips straight to error-handling middleware, and any middleware
// registered after the point of failure (like cors()) never runs — which
// would send an error response with no CORS headers, and the browser would
// report that as a CORS failure rather than a normal HTTP error.
const allowedOrigins = ALLOWED_ORIGINS === '*' ? '*' : ALLOWED_ORIGINS.split(',').map((s) => s.trim());
app.use(cors({ origin: allowedOrigins }));

app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

app.use('/outputs', express.static(OUTPUTS_DIR));

// Proxies text generation (plot / characters / map / script) to Anthropic's
// API using a server-held key. This is what lets the front-end work in any
// regular browser, not just Claude's own in-app preview.
app.post('/api/generate', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' });
  }
  const prompt = req.body && req.body.prompt;
  const maxTokens = (req.body && req.body.maxTokens) || 1000;
  if (!prompt || typeof prompt !== 'string') {
    console.error('Rejected /api/generate request. Content-Type:', req.headers['content-type'], 'Raw body:', req.rawBody, 'Parsed body:', JSON.stringify(req.body));
    return res.status(400).json({ error: 'Request body must include a "prompt" string.' });
  }

  try {
    const anthropicHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    };
    if (ANTHROPIC_WORKSPACE_ID) {
      anthropicHeaders['anthropic-workspace-id'] = ANTHROPIC_WORKSPACE_ID;
    }

    const response = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
      method: 'POST',
      headers: anthropicHeaders,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = (data && data.error && data.error.message) || `Anthropic API error (HTTP ${response.status})`;
      return res.status(response.status).json({ error: msg });
    }
    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!text) {
      return res.status(502).json({ error: 'Empty response from Anthropic API' });
    }
    res.json({ text });
  } catch (err) {
    res.status(502).json({ error: err && err.message ? err.message : 'Failed to reach Anthropic API' });
  }
});

app.post('/api/jobs', (req, res) => {
  const scenes = req.body && req.body.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty "scenes" array.' });
  }

  const job = createJob();
  // Fire-and-forget: processing continues in the background; client polls for status.
  processJob(job, scenes);

  res.status(202).json({ jobId: job.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(publicJobView(job));
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Catches anything that bypassed the route handlers above — most notably a
// malformed JSON body, which express.json() rejects before routing ever runs.
// Logging this is what will reveal the real cause if /api/generate keeps
// returning 400 without the custom log line inside that route firing.
app.use((err, req, res, next) => {
  console.error('Unhandled request error. Content-Type:', req.headers['content-type'], 'Raw body:', req.rawBody, 'Error:', err && err.message);
  res.status(400).json({ error: 'Bad request: ' + (err && err.message ? err.message : 'unknown parsing error') });
});

app.listen(PORT, () => {
  console.log(`Video backend listening on port ${PORT}`);
});
