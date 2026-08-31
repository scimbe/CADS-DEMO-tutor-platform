/**
 * Speech -> text via whisper.cpp's `whisper-cli` with a multilingual ggml
 * model. Same integration pattern as
 * CADS-DEMO-deutschlandatlas-callcenter/src/callcenter_speech/stt.py:
 * shell out to the real whisper-cli binary, parse its JSON output.
 * Deliberately offers no mock-transcript fallback - this module's whole job
 * is STT, so if whisper.cpp is unavailable it fails loudly rather than
 * pretending to have understood the caller.
 *
 * Setup: scripts/setup-whisper-cpp.sh (clones+builds whisper.cpp, downloads
 * a multilingual ggml model into vendor/whisper.cpp/models/).
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.dirname isn't populated the same way under every ESM runner
// (confirmed: ts-jest's transform leaves it undefined) - fileURLToPath is
// the portable form that works both under plain node and under ts-jest.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CLI_PATH = path.join(REPO_ROOT, "vendor", "whisper.cpp", "build", "bin", "whisper-cli");
const DEFAULT_MODEL_PATH = path.join(REPO_ROOT, "vendor", "whisper.cpp", "models", "ggml-base.bin");
const WHISPER_SAMPLE_RATE = 16000; // whisper.cpp requires 16kHz mono PCM WAV input

export class TranscribeError extends Error {}

function defaultCliPath(): string {
  return process.env.WHISPER_CLI_PATH ?? DEFAULT_CLI_PATH;
}

function defaultModelPath(): string {
  return process.env.WHISPER_MODEL_PATH ?? DEFAULT_MODEL_PATH;
}

function run(cmd: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: stderr + String(err) }));
  });
}

/** Converts any ffmpeg-readable audio to 16kHz mono PCM16 WAV - what whisper-cli requires. */
async function toWhisperWav(src: string, dst: string): Promise<void> {
  const result = await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", src, "-ar", String(WHISPER_SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", dst,
  ]);
  if (result.code !== 0) {
    throw new TranscribeError(
      `ffmpeg resample failed (exit ${result.code}). Is ffmpeg installed and on PATH?\n--- stderr ---\n${result.stderr}`
    );
  }
}

export interface TranscribeOptions {
  cliPath?: string;
  modelPath?: string;
  /** ISO 639-1 language code, e.g. "de" or "en". Whisper also accepts "auto". */
  language?: string;
}

interface WhisperJsonSegment {
  text?: string;
}
interface WhisperJsonOutput {
  transcription?: WhisperJsonSegment[];
}

/**
 * Transcribes `audioFile` (any ffmpeg-readable format) to text.
 *
 * Resamples to 16kHz mono WAV first, runs whisper-cli, and returns the
 * concatenated segment text. Throws TranscribeError with a setup hint if
 * whisper-cli/the model are missing, or if whisper-cli exits non-zero.
 */
export async function transcribe(audioFile: string, options: TranscribeOptions = {}): Promise<string> {
  if (!existsSync(audioFile)) {
    throw new TranscribeError(`transcribe: audio file not found: ${audioFile}`);
  }

  const cliPath = options.cliPath ?? defaultCliPath();
  const modelPath = options.modelPath ?? defaultModelPath();
  const language = options.language ?? "de";

  const missing: string[] = [];
  if (!existsSync(cliPath)) {
    missing.push(`whisper-cli binary not found at ${cliPath} (run scripts/setup-whisper-cpp.sh, or set WHISPER_CLI_PATH)`);
  }
  if (!existsSync(modelPath)) {
    missing.push(`whisper.cpp ggml model not found at ${modelPath} (run scripts/setup-whisper-cpp.sh, or set WHISPER_MODEL_PATH)`);
  }
  if (missing.length > 0) {
    throw new TranscribeError("Real transcription is unavailable:\n  - " + missing.join("\n  - "));
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), "cads-tutor-stt-"));
  try {
    const wav16k = path.join(tmpDir, "input-16k.wav");
    await toWhisperWav(audioFile, wav16k);

    const outPrefix = path.join(tmpDir, "transcript");
    const args = [
      "-m", modelPath,
      "-f", wav16k,
      "-l", language,
      "-oj",
      "-of", outPrefix,
      "--no-prints",
    ];
    const result = await run(cliPath, args);
    if (result.code !== 0) {
      throw new TranscribeError(`whisper-cli exited ${result.code}\n--- stderr ---\n${result.stderr}`);
    }

    const jsonPath = `${outPrefix}.json`;
    if (!existsSync(jsonPath)) {
      throw new TranscribeError(`whisper-cli produced no output JSON at ${jsonPath}`);
    }
    const data = JSON.parse(await readFile(jsonPath, "utf-8")) as WhisperJsonOutput;
    const segments = (data.transcription ?? []).map((s) => (s.text ?? "").trim()).filter(Boolean);
    return segments.join(" ").trim();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
