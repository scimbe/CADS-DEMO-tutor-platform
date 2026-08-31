/**
 * Loads a content pack's ingested index and asks it a real question,
 * proving the grounding engine works end to end against real reference
 * content, not just synthetic test fixtures.
 *
 * Run: node dist/cli/demo.js content-packs/rust "your question"
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Bm25Retriever } from "../bm25.js";
import { GroundingEngine } from "../ground.js";
import type { Chunk, Source } from "../types.js";

function main() {
  const packDir = process.argv[2];
  const query = process.argv[3];
  if (!packDir || !query) {
    console.error('Usage: demo <content-pack-dir> "question"');
    process.exit(1);
  }

  const sources: Source[] = JSON.parse(readFileSync(path.join(packDir, "sources.json"), "utf-8"));
  const chunks: Chunk[] = JSON.parse(readFileSync(path.join(packDir, "index.json"), "utf-8"));

  const engine = new GroundingEngine(new Bm25Retriever(), { relevanceThreshold: 5.0, topK: 3 });
  engine.loadSources(sources);
  engine.indexChunks(chunks);

  const answer = engine.ask(query);
  console.log(`Question: ${query}`);
  console.log(`Grounded: ${answer.grounded}`);

  if (!answer.grounded) {
    console.log(`Refusal: ${answer.refusalReason}`);
    return;
  }

  console.log(`\nTop citations:`);
  for (const c of answer.citations) {
    const source = engine.sourceFor(c.chunk);
    console.log(`  [score ${c.score.toFixed(2)}] ${source?.title} — ${c.chunk.section}`);
    console.log(`    ${c.chunk.url}`);
    console.log(`    "${c.chunk.text.slice(0, 140).replace(/\n/g, " ")}..."`);
  }

  console.log(`\n--- Prompt an LLM would receive (never seen by it without this) ---\n`);
  console.log(engine.buildGroundedPrompt(query, answer));
}

main();
