# Deploying the whisper speech-to-text service

A **self-contained** container image for durable hosting of `src/cli/whisper-service.ts`.

## What runs

`dist/cli/whisper-service.js` (pure Node, no npm deps beyond what's already in `package.json`)
serving `POST /transcribe` and `GET /health` on `WHISPER_SERVICE_PORT` (default 8756). It shells
out to **whisper.cpp** `whisper-cli` (built in the image, pinned tag `b4938`, multilingual
`ggml-base`) after resampling the uploaded audio with `ffmpeg`.

**Footprint is static** — every request's temp files are deleted in a `finally` block (see
`src/stt.ts`, `src/cli/whisper-service.ts`). Nothing accumulates unboundedly. Image is dominated
by `ggml-base` (~141 MB).

## Build

```bash
# from the tutor-platform repo root
docker build -f deploy/Dockerfile -t cads-whisper-service:latest .
```

The build fetches, from the network: whisper.cpp (GitHub, tag `b4938`) + its base model
(huggingface.co).

## Run

```bash
cp deploy/.env.template .env   # fill in WHISPER_SERVICE_API_KEY if this will be reachable publicly
docker run --rm --env-file .env -p 8756:8756 cads-whisper-service:latest
```

Then front `:8756` with your tunnel (the same self-service `*.bunsenbrenner.org` flow used for
the other CADS-DEMO-* demos).

## Live-verify (not just container-up)

- `GET /health` returns `{"ok":true}` (200).
- `POST /transcribe` with real audio bytes (e.g. `curl -X POST --data-binary @clip.wav
  "http://localhost:8756/transcribe?lang=en"`) returns a real `{"text": "..."}` — proves
  whisper-cli + the model + ffmpeg resampling all actually work in the built image, not just that
  the container started.
- If `WHISPER_SERVICE_API_KEY` is set: the same request WITHOUT an `Authorization` header
  returns 401.

## Why two (or more) instances, racing

Per the platform's own design: a caller races the same audio against every known
`whisper-service` endpoint (see `src/stt-race.ts`) and uses whichever responds first — no single
instance is a hard dependency, and physical/network proximity to whichever host is currently
fastest wins automatically, without the caller needing to know which deployment that is.

## Env

See `deploy/.env.template`.
