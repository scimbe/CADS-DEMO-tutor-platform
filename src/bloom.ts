import { GroundingEngine } from "./ground.js";
import type { GroundedAnswer } from "./types.js";
import type { BloomLevel } from "./types.js";

export type BloomPromptMode = "explain" | "socratic";

export function promptModeFor(level: BloomLevel): BloomPromptMode {
  return level === "remember" || level === "understand" ? "explain" : "socratic";
}

const SOCRATIC_GUIDANCE: Record<Exclude<BloomLevel, "remember" | "understand">, string> = {
  apply: "help the student apply a concept from the excerpts to a new, concrete case they haven't seen worked through yet",
  analyze: "help the student break the idea down into its parts, or compare it against a related idea from the excerpts, to see how it actually works",
  evaluate: "help the student judge or weigh a trade-off from the excerpts against an explicit criterion, rather than just describing it",
  create: "help the student combine or extend ideas from the excerpts into something new they design themselves",
};

const ESCALATION_TIERS = [
  "Ask exactly ONE open guiding question that starts the student down the right path themselves. " +
    "Your entire response must be that one question and nothing else - no lead-in sentence, no " +
    "numbered breakdown, no bullet points, no explanation before it. A response that explains the " +
    "concept and THEN asks a question has failed this task, even if a question is present.",
  "The student is still working on it. Ask a narrower, more specific guiding question than before - point at the exact piece of the excerpts that matters most, but still do not answer.",
  "The student is still stuck after two guiding questions. Give a near-direct hint - name the specific concept or excerpt detail they're missing - but still stop just short of stating the final answer outright.",
] as const; // index 0 = attempt 1, index 1 = attempt 2, index 2 = attempt 3+

export interface BuildTutorPromptOptions {
  bloomLevel?: BloomLevel;
  attemptNumber?: number;
}

export function buildTutorPrompt(
  engine: GroundingEngine,
  query: string,
  answer: GroundedAnswer,
  options: BuildTutorPromptOptions = {}
): { prompt: string; mode: BloomPromptMode; bloomLevel: BloomLevel } {
  const level = options.bloomLevel ?? "understand";
  const mode = promptModeFor(level);

  if (mode === "explain") {
    return { prompt: engine.buildGroundedPrompt(query, answer), mode, bloomLevel: level };
  }

  if (!answer.grounded) {
    throw new Error("buildTutorPrompt called on an ungrounded answer - check answer.grounded first.");
  }

  const tierIndex = Math.min(Math.max((options.attemptNumber ?? 1) - 1, 0), ESCALATION_TIERS.length - 1);
  const guidance = SOCRATIC_GUIDANCE[level as Exclude<BloomLevel, "remember" | "understand">];

  const prompt = [
    "You are CaDS Tutor. The student is working at the Bloom's taxonomy level",
    `"${level}". Using ONLY the numbered reference excerpts below, and inventing`,
    "no fact, example, or detail that isn't already in them, " + guidance + ".",
    "Do not simply state the answer.",
    "",
    ESCALATION_TIERS[tierIndex],
    "",
    "Reference excerpts:",
    engine.citationContext(answer),
    "",
    `Student's question: ${query}`,
  ].join("\n");

  return { prompt, mode, bloomLevel: level };
}
