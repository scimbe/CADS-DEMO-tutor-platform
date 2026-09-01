/**
 * Runs one real student turn end to end: retrieval, grounding, the LLM,
 * and dialog memory - the same GroundingEngine + LlmClient + TutorMemory
 * wiring a real tutor extension would use, driven from the CLI.
 *
 * Run: node --env-file=.env dist/cli/tutor.js content-packs/rust student-1 "your question"
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bm25Retriever } from "../bm25.js";
import { CurriculumGraph, loadCurriculumObjectives } from "../curriculum.js";
import { GroundingEngine } from "../ground.js";
import { LearningEventStore } from "../learning-event.js";
import { LlmClient } from "../llm.js";
import { TutorMemory } from "../memory.js";
import { TutorSession } from "../session.js";
import type { Chunk, Source } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");

async function main() {
  const packDir = process.argv[2];
  const studentId = process.argv[3];
  const query = process.argv.slice(4).join(" ");
  if (!packDir || !studentId || !query) {
    console.error('Usage: tutor <content-pack-dir> <studentId> "question"');
    process.exit(1);
  }

  const sources: Source[] = JSON.parse(readFileSync(path.join(packDir, "sources.json"), "utf-8"));
  const chunks: Chunk[] = JSON.parse(readFileSync(path.join(packDir, "index.json"), "utf-8"));
  const manifest = JSON.parse(readFileSync(path.join(packDir, "manifest.json"), "utf-8"));

  const relevanceThreshold = manifest.relevanceThreshold ?? 5.0;
  const engine = new GroundingEngine(new Bm25Retriever(), { relevanceThreshold });
  engine.loadSources(sources);
  engine.indexChunks(chunks);

  const llm = new LlmClient({
    baseUrl: process.env.TUTOR_LLM_BASE_URL!,
    apiKey: process.env.TUTOR_LLM_API_KEY!,
    model: process.env.TUTOR_LLM_MODEL!,
  });

  const memory = new TutorMemory(path.join(process.cwd(), "memory-data"));

  // Turn-end proactive suggestion (Proactive Tutor Roadmap, Phase A #3) is opt-in - only
  // wired up when a real multi-track curriculum.json exists, matching the track this content
  // pack's directory name names (content-packs/rust -> "rust"). Falls back to no suggestion
  // (matching TutorSession's own default) rather than failing the whole CLI turn if the
  // curriculum file or track isn't found - grounding/dialog is the load-bearing feature here.
  const track = path.basename(packDir);
  const curriculumPath = path.join(REPO_ROOT, "content-packs", "curriculum.json");
  let curriculum: CurriculumGraph | undefined;
  let learningEvents: LearningEventStore | undefined;
  try {
    curriculum = new CurriculumGraph(loadCurriculumObjectives(curriculumPath));
    learningEvents = new LearningEventStore(path.join(REPO_ROOT, "memory-data", "learning-events.db"));
  } catch (err) {
    console.warn(`tutor CLI: turn-end suggestion unavailable (${err instanceof Error ? err.message : String(err)})`);
  }

  const session = new TutorSession(engine, llm, memory, { curriculum, learningEvents, track });
  const result = await session.ask(studentId, query);
  learningEvents?.close();

  console.log(`Question: ${query}`);

  if (result.kind === "refused") {
    console.log(`Refused: ${result.reason}`);
    return;
  }

  if (result.kind === "llm-error") {
    console.log(`LLM error: ${result.message}`);
    console.log(`\nCitations (so the student still gets the reference material):`);
    for (const c of result.citations) {
      const source = engine.sourceFor(c.chunk);
      console.log(`  [score ${c.score.toFixed(2)}] ${source?.title} — ${c.chunk.section}`);
      console.log(`    ${c.chunk.url}`);
    }
    return;
  }

  console.log(`\n${result.text}`);
  console.log(`\nCitations:`);
  for (const c of result.citations) {
    const source = engine.sourceFor(c.chunk);
    console.log(`  [score ${c.score.toFixed(2)}] ${source?.title} — ${c.chunk.section}`);
    console.log(`    ${c.chunk.url}`);
  }

  if (result.nextSuggestion) {
    console.log(`\nWhat's next: [${result.nextSuggestion.bloomLevel}] ${result.nextSuggestion.statement}`);
    console.log(`  (${result.nextSuggestion.objectiveId})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
