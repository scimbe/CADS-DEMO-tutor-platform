/**
 * "What should this student work on next" - the first real, runnable exercise of the whole
 * chain the Proactive Tutor Roadmap's Phase A is built around: content-packs/curriculum.json
 * (CurriculumGraph) + real event history (LearningEventStore) + a real mastery estimate
 * (mastery.ts's createIsSatisfied), not just isolated unit tests of each piece.
 *
 * Run: node dist/cli/frontier.js <track> <studentId>
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CurriculumGraph, loadCurriculumObjectives } from "../curriculum.js";
import { LearningEventStore } from "../learning-event.js";
import { computeMastery, createIsSatisfied } from "../mastery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");

function main() {
  const track = process.argv[2];
  const studentId = process.argv[3];
  if (!track || !studentId) {
    console.error("Usage: frontier <track> <studentId>");
    console.error("  track: firmware | rust | javascript");
    process.exit(1);
  }

  const curriculumPath = path.join(REPO_ROOT, "content-packs", "curriculum.json");
  const objectives = loadCurriculumObjectives(curriculumPath);
  const graph = new CurriculumGraph(objectives);

  const store = new LearningEventStore(path.join(REPO_ROOT, "memory-data", "learning-events.db"));
  const isSatisfied = createIsSatisfied(store, studentId);

  const frontier = graph.computeFrontier(track, isSatisfied);

  console.log(`Frontier for ${studentId} on ${track}:\n`);
  if (frontier.length === 0) {
    console.log("  (nothing legal to attempt yet, or everything in this track is mastered)");
  }
  for (const objective of frontier) {
    const mastery = computeMastery(store.query({ entityId: studentId, objectiveId: objective.id }));
    console.log(`  [${objective.bloomLevel}] ${objective.id}`);
    console.log(`    ${objective.statement}`);
    console.log(`    current mastery estimate: ${(mastery * 100).toFixed(0)}%`);
  }

  store.close();
}

main();
