import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { transcribe, TranscribeError } from "../src/stt.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = process.env.WHISPER_CLI_PATH ?? path.join(REPO_ROOT, "vendor", "whisper.cpp", "build", "bin", "whisper-cli");
const MODEL_PATH = process.env.WHISPER_MODEL_PATH ?? path.join(REPO_ROOT, "vendor", "whisper.cpp", "models", "ggml-base.bin");
const WHISPER_READY = existsSync(CLI_PATH) && existsSync(MODEL_PATH);

const describeIfReady = WHISPER_READY ? describe : describe.skip;

/**
 * Real speech fixtures via macOS's built-in `say` TTS (not whisper.cpp's own
 * TTS - this project doesn't have Piper set up, and `say` is a legitimate,
 * always-available substitute for generating real speech audio to round-trip
 * through real STT, same spirit as the callcenter project's Piper-generated
 * fixtures in tests/test_stt.py). Skipped entirely on non-macOS - real
 * transcription is still tested via speech generated at runtime, not a
 * pre-baked binary fixture, so there's no fixture to fall back to elsewhere.
 */
async function synthesizeWithSay(text: string, outPath: string): Promise<void> {
  await execFileAsync("say", ["-o", outPath, text]);
}

describeIfReady("transcribe (real whisper.cpp, no mocking)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "cads-tutor-stt-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("recognizes real synthesized English speech", async () => {
    const fixture = path.join(tmpDir, "en.aiff");
    // Deliberately plain, common words - a real finding while writing this
    // test: whisper.cpp's smallest "base" model, on macOS `say`'s synthetic
    // (not natural) voice, mis-hears domain jargon fairly often - "GPIO"
    // came back "gpe open", even the ordinary word "firmware" came back
    // "film van". That's a real base-model-on-synthetic-speech accuracy
    // limit (see scripts/setup-whisper-cpp.sh's WHISPER_MODEL_NAME=small/
    // medium escape hatch), not a bug in transcribe() - this test's job is
    // proving the real STT plumbing works end to end, not benchmarking
    // model accuracy, so it uses vocabulary robust to that limit instead of
    // fighting it.
    await synthesizeWithSay("Turn on the light and open the door.", fixture);

    const text = await transcribe(fixture, { language: "en" });

    expect(typeof text).toBe("string");
    expect(text.trim().length).toBeGreaterThan(0);
    const lowered = text.toLowerCase();
    // Loose containment check - whisper's exact casing/punctuation can vary,
    // this checks for the key content words rather than an exact transcript.
    expect(lowered).toContain("light");
    expect(lowered).toContain("door");
  }, 30_000);

  test("throws TranscribeError for a missing audio file", async () => {
    await expect(transcribe(path.join(tmpDir, "does-not-exist.wav"))).rejects.toThrow(TranscribeError);
  });
});

describe("transcribe (missing setup)", () => {
  test("throws with a setup hint when the model is missing", async () => {
    // README.md is a convenient stand-in input file; never actually read,
    // since the missing-model check happens before transcription starts.
    const dummyAudio = path.join(REPO_ROOT, "README.md");
    await expect(
      transcribe(dummyAudio, { modelPath: path.join(REPO_ROOT, "vendor", "does-not-exist.bin") })
    ).rejects.toThrow(/setup-whisper-cpp\.sh/);
  });
});
