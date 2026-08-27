# Exponential Imagination — Backend

Two things, one server:

1. **Text generation proxy** — plot, characters, map, and script generation
   now route through here to Anthropic's API, using a server-held key. This
   is required for the app to work in a normal browser: calling
   `api.anthropic.com` directly from the front-end only works inside
   Claude's own in-app preview (which injects credentials invisibly) — in
   any other browser it fails immediately with no valid auth.
2. **Video generation** — turns script scenes into short AI-generated video
   clips (via xAI's `grok-imagine-video`), stitches them into one final
   movie, and reports progress to the front-end.

Both xAI and Anthropic API keys stay server-side, never in the front-end or the repo.

## ⚠️ First: rotate any exposed API key

If a key was ever pasted into chat, **treat it as compromised.** Revoke it
and generate a fresh one — for xAI at https://console.x.ai/team/default/api-keys,
for Anthropic at https://console.anthropic.com/settings/keys. Never paste
API keys into chat, client-side JavaScript, or a public repo — this backend
exists specifically so keys never have to leave your server.

## Setup

```bash
npm install
```

`x.env` is already the environment file template (no setup copy step needed
— just edit it directly).

Edit `x.env` and set:
- `XAI_API_KEY` — your xAI key
- `ANTHROPIC_API_KEY` — your Anthropic key
- `ALLOWED_ORIGINS` — the origin(s) your front-end is served from (use `*` only while testing locally)

Then:

```bash
npm start
```

The server listens on `PORT` (default `3001`) and exposes:

- `POST /api/generate` — body: `{ "prompt": "...", "maxTokens": 1000 }`. Returns `{ "text": "..." }`. Used for plot/characters/map/script generation.
- `POST /api/jobs` — body: `{ "scenes": [ { "title", "location", "characters", "description", "dialogue" }, ... ] }` (4 scenes expected). Returns `{ "jobId": "..." }` immediately; processing happens in the background.
- `GET /api/jobs/:id` — returns `{ id, status, progress, videoUrl, error }`. `status` is one of `starting → prompts_created → generating → combining → done` (or `error`).
- `GET /outputs/<jobId>.mp4` — the final combined video, once `status` is `done`.

## How video generation works

1. Builds **2 prompts per scene** (8 total for 4 scenes), each asking xAI for a ~14 second clip — the two clips per scene are written to cover the first and second half of that scene's action/dialogue, so together they span the scene.
2. Calls `POST https://api.x.ai/v1/videos/generations` for each prompt, then polls `GET https://api.x.ai/v1/videos/{request_id}` until `status: "done"`.
3. Downloads each finished clip.
4. Uses `ffmpeg` (via `fluent-ffmpeg` + `ffmpeg-static`, no system install required) to concatenate all 8 clips, in order, into one final `.mp4`.
5. Serves that file statically and reports it back to the client.

## Connecting the front-end

In `creation-app.html`, set:

```js
var BACKEND_URL = 'https://your-deployed-backend.example.com';
```

to wherever you deploy this server. For local testing, that's typically
`http://localhost:3001` — but note that a phone testing the app over Wi-Fi
can't reach `localhost` on your computer; use your machine's LAN IP, or a
tunnel like `ngrok`, or deploy this to a real host (Render, Railway, Fly.io,
a VPS, etc.).

## Things to double-check before relying on this

- **Resolution values**: xAI's published examples only show `"720p"`
  explicitly. `x.env` defaults `XAI_VIDEO_RESOLUTION` to `480p` as a
  best-effort "low resolution" setting — verify the currently accepted
  values in [xAI's docs](https://docs.x.ai/developers/rest-api-reference/inference/videos)
  and adjust if the API rejects it.
- **Rate limits / cost**: this processes clips **sequentially** (one at a
  time) to stay safe by default — 8 clips per movie. Video generation is
  metered; check xAI's pricing before generating at volume. You can increase
  concurrency in `processJob()` once you've confirmed your plan's limits.
- **Job store is in-memory**: jobs are lost on server restart and this
  won't work across multiple server instances/load-balanced replicas as-is.
  For production use, back the job store with Redis or a database.
- **No auth on the API**: `/api/jobs` is open to anyone who can reach the
  server. Add an auth check (API key, session, etc.) before deploying this
  publicly, or it can be used to run up your xAI bill.
- **ffmpeg concat approach**: this re-encodes (via the `concat` filter, not
  the faster demuxer) since AI-generated clips may not share identical
  codecs — this is safer but slower/heavier on CPU. Fine for occasional use;
  consider a queue/worker if you expect concurrent movie generations.
