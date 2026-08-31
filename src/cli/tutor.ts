/**
 * Runs one real student turn end to end: retrieval, grounding, the LLM,
 * and dialog memory - the same GroundingEngine + LlmClient + TutorMemory
 * wiring a real tutor extension would use, driven from the CLI.
 *
 * Run: node --env-file=.env dist/cli/tutor.js content-packs/rust student-1 "your question"
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Bm25Retriever } from "../bm25.js";
import { GroundingEngine } from "../ground.js";
import { LlmClient } from "../llm.js";
import { TutorMemory } from "../memory.js";
import { TutorSession } from "../session.js";
import type { Chunk, Source } from "../types.js";

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

  const engine = new GroundingEngine(new Bm25Retriever(), { relevanceThreshold: 5.0 });
  engine.loadSources(sources);
  engine.indexChunks(chunks);

  const llm = new LlmClient({
    baseUrl: process.env.TUTOR_LLM_BASE_URL!,
    apiKey: process.env.TUTOR_LLM_API_KEY!,
    model: process.env.TUTOR_LLM_MODEL!,
  });

  const memory = new TutorMemory(path.join(process.cwd(), "memory-data"));

  const session = new TutorSession(engine, llm, memory);
  const result = await session.ask(studentId, query);

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
