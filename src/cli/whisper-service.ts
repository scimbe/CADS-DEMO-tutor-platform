/**
 * A real, standalone HTTP service in front of src/stt.ts's whisper.cpp
 * wrapper: POST raw audio bytes, get JSON text back. Kept as its own tiny
 * process (not baked into TutorSession) because whisper.cpp is a native
 * binary + a multi-hundred-MB model file - a dependency footprint the
 * grounding/dialog library itself has no business carrying, the same
 * reasoning that keeps student-memory a separate package.
 *
 * Run: node --env-file=.env dist/cli/whisper-service.js
 * Then: curl -X POST --data-binary @clip.wav "http://localhost:8756/transcribe?lang=de"
 */

import { createServer } from "node:http";
import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { transcribe, TranscribeError } from "../stt.js";

const PORT = Number(process.env.WHISPER_SERVICE_PORT ?? 8756);
const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25MB - generous for a few minutes of compressed speech

function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "POST" || !req.url?.startsWith("/transcribe")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "POST /transcribe with raw audio bytes, or GET /health" }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const language = url.searchParams.get("lang") ?? "auto";

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(413, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  if (body.length === 0) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "empty request body - POST raw audio bytes" }));
    return;
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "cads-whisper-service-"));
  const audioPath = path.join(tmpDir, "input.audio");
  try {
    await writeFile(audioPath, body);
    const text = await transcribe(audioPath, { language });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text }));
  } catch (err) {
    const status = err instanceof TranscribeError ? 503 : 500;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

server.listen(PORT, () => {
  console.log(`whisper-service listening on http://localhost:${PORT} (POST /transcribe, GET /health)`);
});
