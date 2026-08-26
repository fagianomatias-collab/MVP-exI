# Exponential Imagination — Video Generation Backend

Turns your story's scenes into short AI-generated video clips (via xAI's
`grok-imagine-video`), stitches them into one final movie, and reports
progress to the front-end — while keeping your xAI API key server-side,
where it belongs.

## ⚠️ First: rotate your API key

A key was pasted into a chat earlier in this project. **Treat it as
compromised.** Go to https://console.x.ai/team/default/api-keys, revoke it,
and generate a brand new one. Never paste API keys into chat, client-side
JavaScript, or a public repo — this backend exists specifically so the key
never has to leave your server.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set:
- `XAI_API_KEY` — your new key
- `ALLOWED_ORIGINS` — the origin(s) your front-end is served from (use `*` only while testing locally)

Then:

```bash
npm start
```

The server listens on `PORT` (default `3001`) and exposes:

- `POST /api/jobs` — body: `{ "scenes": [ { "title", "location", "characters", "description", "dialogue" }, ... ] }` (4 scenes expected). Returns `{ "jobId": "..." }` immediately; processing happens in the background.
- `GET /api/jobs/:id` — returns `{ id, status, progress, videoUrl, error }`. `status` is one of `starting → prompts_created → generating → combining → done` (or `error`).
- `GET /outputs/<jobId>.mp4` — the final combined video, once `status` is `done`.

## How it works

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
  explicitly. `.env.example` defaults `XAI_VIDEO_RESOLUTION` to `480p` as a
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
