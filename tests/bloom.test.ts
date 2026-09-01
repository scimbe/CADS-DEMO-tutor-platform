import { buildTutorPrompt, promptModeFor } from "../src/bloom.js";
import { Bm25Retriever } from "../src/bm25.js";
import { GroundingEngine } from "../src/ground.js";
import type { Chunk, Source } from "../src/types.js";

const source: Source = {
  id: "rust-book",
  title: "The Rust Programming Language",
  license: "MIT OR Apache-2.0",
  url: "https://doc.rust-lang.org/book/",
};

const chunks: Chunk[] = [
  {
    id: "rust-book-0",
    sourceId: "rust-book",
    section: "Ownership",
    url: "https://doc.rust-lang.org/book/#ownership",
    text: "Ownership is Rust's most unique feature and enables memory safety guarantees without a garbage collector.",
  },
  {
    id: "rust-book-1",
    sourceId: "rust-book",
    section: "Structs",
    url: "https://doc.rust-lang.org/book/#structs",
    text: "A struct lets you package together and name multiple related values that make up a meaningful group.",
  },
];

function makeEngine(threshold = 0.5) {
  const engine = new GroundingEngine(new Bm25Retriever(), { relevanceThreshold: threshold });
  engine.loadSources([source]);
  engine.indexChunks(chunks);
  return engine;
}

describe("promptModeFor", () => {
  it("returns explain for remember and understand", () => {
    expect(promptModeFor("remember")).toBe("explain");
    expect(promptModeFor("understand")).toBe("explain");
  });

  it("returns socratic for apply, analyze, evaluate, create", () => {
    expect(promptModeFor("apply")).toBe("socratic");
    expect(promptModeFor("analyze")).toBe("socratic");
    expect(promptModeFor("evaluate")).toBe("socratic");
    expect(promptModeFor("create")).toBe("socratic");
  });
});

describe("buildTutorPrompt", () => {
  it("with no bloomLevel option produces a prompt identical to buildGroundedPrompt", () => {
    const engine = makeEngine();
    const query = "What is ownership in Rust?";
    const answer = engine.ask(query);
    expect(answer.grounded).toBe(true);

    const result = buildTutorPrompt(engine, query, answer);
    expect(result.mode).toBe("explain");
    expect(result.bloomLevel).toBe("understand");
    expect(result.prompt).toBe(engine.buildGroundedPrompt(query, answer));
  });

  it("with bloomLevel analyze produces a socratic prompt that cites but doesn't answer", () => {
    const engine = makeEngine();
    const query = "What is ownership in Rust?";
    const answer = engine.ask(query);
    expect(answer.grounded).toBe(true);

    const result = buildTutorPrompt(engine, query, answer, { bloomLevel: "analyze" });
    expect(result.mode).toBe("socratic");
    expect(result.bloomLevel).toBe("analyze");
    expect(result.prompt).toContain("memory safety guarantees");
    expect(result.prompt).not.toContain("Ownership means one owner at a time");
    expect(result.prompt).toContain(
      "help the student break the idea down into its parts, or compare it against a related idea from the excerpts, to see how it actually works"
    );
  });

  it("produces visibly different escalation text across attempt numbers, clamping at 3+", () => {
    const engine = makeEngine();
    const query = "What is ownership in Rust?";
    const answer = engine.ask(query);

    const attempt1 = buildTutorPrompt(engine, query, answer, { bloomLevel: "apply", attemptNumber: 1 });
    const attempt2 = buildTutorPrompt(engine, query, answer, { bloomLevel: "apply", attemptNumber: 2 });
    const attempt3 = buildTutorPrompt(engine, query, answer, { bloomLevel: "apply", attemptNumber: 3 });
    const attempt5 = buildTutorPrompt(engine, query, answer, { bloomLevel: "apply", attemptNumber: 5 });

    expect(attempt1.prompt).not.toBe(attempt2.prompt);
    expect(attempt2.prompt).not.toBe(attempt3.prompt);
    expect(attempt1.prompt).not.toBe(attempt3.prompt);
    expect(attempt5.prompt).toBe(attempt3.prompt);
  });

  it("tier 1 explicitly forbids an explanatory lead-in before the question", () => {
    // Real finding, not hypothetical: a live LLM call against this exact tier's earlier,
    // weaker wording ("Ask exactly ONE open guiding question... do not simply state the
    // answer") reproducibly padded its single question with a 3-point explanatory
    // breakdown that amounted to the direct answer, satisfying the letter of the
    // instruction but not the spirit. Verified end-to-end against the live LLM endpoint
    // that the strengthened wording below fixes it (identical across two real calls).
    const engine = makeEngine();
    const query = "What is ownership in Rust?";
    const answer = engine.ask(query);
    const attempt1 = buildTutorPrompt(engine, query, answer, { bloomLevel: "apply", attemptNumber: 1 });
    expect(attempt1.prompt).toContain("no lead-in sentence, no");
    expect(attempt1.prompt).toContain("has failed this task");
  });

  it("throws if called with an ungrounded answer", () => {
    const engine = makeEngine();
    const query = "What is the capital of France?";
    const ungrounded = engine.ask(query);
    expect(ungrounded.grounded).toBe(false);

    expect(() => buildTutorPrompt(engine, query, ungrounded)).toThrow();
    expect(() => buildTutorPrompt(engine, query, ungrounded, { bloomLevel: "apply" })).toThrow();
  });

  it("returns hintTier 0 for explain mode and the real escalation tier for socratic mode", () => {
    // Real, load-bearing new field: the backbone architecture's learning_event log needs to
    // know which escalation tier a turn actually used - this is what a caller records, since
    // TutorSession can't know the eventual outcome within one turn (see learning-event.ts).
    const engine = makeEngine();
    const query = "What is ownership in Rust?";
    const answer = engine.ask(query);

    expect(buildTutorPrompt(engine, query, answer).hintTier).toBe(0);
    expect(buildTutorPrompt(engine, query, answer, { bloomLevel: "understand" }).hintTier).toBe(0);
    expect(buildTutorPrompt(engine, query, answer, { bloomLevel: "apply", attemptNumber: 1 }).hintTier).toBe(1);
    expect(buildTutorPrompt(engine, query, answer, { bloomLevel: "apply", attemptNumber: 2 }).hintTier).toBe(2);
    expect(buildTutorPrompt(engine, query, answer, { bloomLevel: "apply", attemptNumber: 3 }).hintTier).toBe(3);
    expect(buildTutorPrompt(engine, query, answer, { bloomLevel: "apply", attemptNumber: 5 }).hintTier).toBe(3);
  });
});
