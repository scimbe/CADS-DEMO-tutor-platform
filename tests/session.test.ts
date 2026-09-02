import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { jest } from "@jest/globals";
import { Bm25Retriever } from "../src/bm25.js";
import { CurriculumGraph } from "../src/curriculum.js";
import type { CurriculumObjective } from "../src/curriculum.js";
import { GroundingEngine } from "../src/ground.js";
import { LearningEventStore } from "../src/learning-event.js";
import { createIsSatisfied } from "../src/mastery.js";
import type { Explainer, InteractionRecorder } from "../src/session.js";
import { TutorSession } from "../src/session.js";
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

describe("TutorSession", () => {
  it("refuses without ever calling the llm or memory when the query isn't grounded", async () => {
    const engine = makeEngine();
    const llm: Explainer = {
      complete: jest.fn<Explainer["complete"]>().mockResolvedValue("should not be called"),
    };
    const memory: InteractionRecorder = {
      recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>(),
    };
    const session = new TutorSession(engine, llm, memory);

    const result = await session.ask("student-1", "What is the capital of France?");

    expect(result.kind).toBe("refused");
    expect(llm.complete).not.toHaveBeenCalled();
    expect(memory.recordInteraction).not.toHaveBeenCalled();
  });

  it("calls the llm with exactly the grounded prompt and records the interaction once on success", async () => {
    const engine = makeEngine();
    const llm: Explainer = {
      complete: jest.fn<Explainer["complete"]>().mockResolvedValue("Ownership means one owner at a time."),
    };
    const memory: InteractionRecorder = {
      recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined),
    };
    const session = new TutorSession(engine, llm, memory);

    const query = "What is ownership in Rust?";
    const answer = engine.ask(query);
    const expectedPrompt = engine.buildGroundedPrompt(query, answer);

    const result = await session.ask("student-1", query);

    expect(llm.complete).toHaveBeenCalledWith(expectedPrompt);
    expect(memory.recordInteraction).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.text).toBe("Ownership means one owner at a time.");
      expect(result.citations[0].chunk.id).toBe("rust-book-0");
    }
  });

  it("returns llm-error with the original citations and never records when the llm rejects", async () => {
    const engine = makeEngine();
    const llm: Explainer = {
      complete: jest.fn<Explainer["complete"]>().mockRejectedValue(new Error("upstream timeout")),
    };
    const memory: InteractionRecorder = {
      recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>(),
    };
    const session = new TutorSession(engine, llm, memory);

    const query = "What is ownership in Rust?";
    const answer = engine.ask(query);

    const result = await session.ask("student-1", query);

    expect(result.kind).toBe("llm-error");
    if (result.kind === "llm-error") {
      expect(result.message).toBe("upstream timeout");
      expect(result.citations).toEqual(answer.citations);
    }
    expect(memory.recordInteraction).not.toHaveBeenCalled();
  });

  it("ask() with no options behaves exactly as before (explain mode, understand level)", async () => {
    const engine = makeEngine();
    const llm: Explainer = {
      complete: jest.fn<Explainer["complete"]>().mockResolvedValue("Ownership means one owner at a time."),
    };
    const memory: InteractionRecorder = {
      recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined),
    };
    const session = new TutorSession(engine, llm, memory);

    const query = "What is ownership in Rust?";
    const answer = engine.ask(query);
    const expectedPrompt = engine.buildGroundedPrompt(query, answer);

    const result = await session.ask("student-1", query);

    expect(llm.complete).toHaveBeenCalledWith(expectedPrompt);
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.mode).toBe("explain");
      expect(result.bloomLevel).toBe("understand");
    }
  });

  it("passing bloomLevel:'apply' produces a socratic answer and prompts the llm with the socratic instruction", async () => {
    const engine = makeEngine();
    const complete = jest.fn<Explainer["complete"]>().mockResolvedValue("What do you think happens if you try that?");
    const llm: Explainer = { complete };
    const memory: InteractionRecorder = {
      recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined),
    };
    const session = new TutorSession(engine, llm, memory);

    const query = "What is ownership in Rust?";
    const result = await session.ask("student-1", query, { bloomLevel: "apply" });

    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.mode).toBe("socratic");
      expect(result.bloomLevel).toBe("apply");
      expect(result.hintTier).toBe(1);
    }

    const calledPrompt = complete.mock.calls[0][0];
    expect(calledPrompt).toContain("help the student apply a concept");
    expect(calledPrompt).not.toContain("Answer the student's question using ONLY the numbered");

    const recordedMetadata = (memory.recordInteraction as jest.Mock).mock.calls[0][2];
    expect(recordedMetadata).toMatchObject({ bloomLevel: "apply", mode: "socratic", hintTier: 1 });
  });

  it("nextSuggestion is null when no curriculum/learningEvents/track were supplied (opt-in, backward compatible)", async () => {
    const engine = makeEngine();
    const llm: Explainer = { complete: jest.fn<Explainer["complete"]>().mockResolvedValue("answer") };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined) };
    const session = new TutorSession(engine, llm, memory);

    const result = await session.ask("student-1", "What is ownership in Rust?");
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.nextSuggestion).toBeNull();
    }
  });
});

describe("TutorSession's turn-end proactive suggestion (Proactive Tutor Roadmap, Phase A #3)", () => {
  let dir: string;
  let store: LearningEventStore;

  const objectives: CurriculumObjective[] = [
    { id: "rust-ownership", track: "rust", unitId: "rust-ownership", bloomLevel: "understand", statement: "Explain ownership.", sourceDocIds: ["rust-book-0"], prerequisiteObjectiveIds: [] },
    { id: "rust-structs", track: "rust", unitId: "rust-structs", bloomLevel: "apply", statement: "Define a struct.", sourceDocIds: ["rust-book-1"], prerequisiteObjectiveIds: ["rust-ownership"] },
  ];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cads-session-suggestion-test-"));
    store = new LearningEventStore(path.join(dir, "events.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeSession(llmText = "Ownership means one owner at a time.") {
    const engine = makeEngine();
    const llm: Explainer = { complete: jest.fn<Explainer["complete"]>().mockResolvedValue(llmText) };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined) };
    const curriculum = new CurriculumGraph(objectives);
    return new TutorSession(engine, llm, memory, { curriculum, learningEvents: store, track: "rust" });
  }

  it("suggests the true root objective for a student with no history", async () => {
    const session = makeSession();
    const result = await session.ask("student-1", "What is ownership in Rust?");
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.nextSuggestion).toEqual({ objectiveId: "rust-ownership", bloomLevel: "understand", statement: "Explain ownership." });
    }
  });

  it("advances the suggestion after a real independent_success event is recorded for the current objective", async () => {
    store.record({
      entityId: "student-1",
      sessionId: "s1",
      track: "rust",
      objectiveId: "rust-ownership",
      bloomLevel: "understand",
      exchangeType: null,
      source: "chat_answer",
      hintTierReached: 0,
      outcome: "independent_success",
    });

    const session = makeSession();
    const result = await session.ask("student-1", "What is ownership in Rust?");
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.nextSuggestion?.objectiveId).toBe("rust-structs");
    }
  });

  it("is scoped per-student - another student's mastery never leaks into this student's suggestion", async () => {
    store.record({
      entityId: "student-OTHER",
      sessionId: "s1",
      track: "rust",
      objectiveId: "rust-ownership",
      bloomLevel: "understand",
      exchangeType: null,
      source: "chat_answer",
      hintTierReached: 0,
      outcome: "independent_success",
    });

    const session = makeSession();
    const result = await session.ask("student-1", "What is ownership in Rust?");
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.nextSuggestion?.objectiveId).toBe("rust-ownership");
    }
  });

  it("never appears on a refused or llm-error turn", async () => {
    const engine = makeEngine();
    const failingLlm: Explainer = { complete: jest.fn<Explainer["complete"]>().mockRejectedValue(new Error("boom")) };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>() };
    const curriculum = new CurriculumGraph(objectives);
    const session = new TutorSession(engine, failingLlm, memory, { curriculum, learningEvents: store, track: "rust" });

    const refused = await session.ask("student-1", "What is the capital of France?");
    expect(refused.kind).toBe("refused");
    expect("nextSuggestion" in refused).toBe(false);

    const errored = await session.ask("student-1", "What is ownership in Rust?");
    expect(errored.kind).toBe("llm-error");
    expect("nextSuggestion" in errored).toBe(false);
  });
});

describe("TutorSession.checkIn - proactive, editor-triggered feedback (Proactive Tutor Roadmap, Phase B)", () => {
  let dir: string;
  let store: LearningEventStore;

  const objectives: CurriculumObjective[] = [
    { id: "rust-ownership", track: "rust", unitId: "rust-ownership", bloomLevel: "understand", statement: "Explain ownership.", sourceDocIds: ["rust-book-0"], prerequisiteObjectiveIds: [] },
    { id: "rust-structs", track: "rust", unitId: "rust-structs", bloomLevel: "apply", statement: "Define a struct.", sourceDocIds: ["rust-book-1"], prerequisiteObjectiveIds: ["rust-ownership"] },
  ];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cads-session-checkin-test-"));
    store = new LearningEventStore(path.join(dir, "events.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("grounds the check-in in exactly the objective's own sourceDocIds, not a BM25 search of the code", async () => {
    const engine = makeEngine();
    const complete = jest.fn<Explainer["complete"]>().mockResolvedValue("You're on the right track - this correctly takes ownership.");
    const llm: Explainer = { complete };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined) };
    const curriculum = new CurriculumGraph(objectives);
    const session = new TutorSession(engine, llm, memory, { curriculum, learningEvents: store, track: "rust" });

    const result = await session.checkIn("student-1", "rust-ownership", "fn main() { let s = String::from(\"hi\"); }");

    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.text).toBe("You're on the right track - this correctly takes ownership.");
      expect(result.citations[0].chunk.id).toBe("rust-book-0");
      expect(result.mode).toBe("explain");
      expect(result.bloomLevel).toBe("understand");
    }

    const calledPrompt = complete.mock.calls[0][0];
    expect(calledPrompt).toContain("PROACTIVE check-in");
    expect(calledPrompt).toContain("The student did not ask you anything");
    expect(calledPrompt).toContain("Explain ownership.");
    expect(calledPrompt).toContain("String::from");

    const recordedMetadata = (memory.recordInteraction as jest.Mock).mock.calls[0][2];
    expect(recordedMetadata).toMatchObject({ objectiveId: "rust-ownership", mode: "checkin" });
  });

  it("includes a nextSuggestion, exactly like ask()", async () => {
    const engine = makeEngine();
    const llm: Explainer = { complete: jest.fn<Explainer["complete"]>().mockResolvedValue("Looks right so far.") };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined) };
    const curriculum = new CurriculumGraph(objectives);
    const session = new TutorSession(engine, llm, memory, { curriculum, learningEvents: store, track: "rust" });

    const result = await session.checkIn("student-1", "rust-ownership", "some code");
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.nextSuggestion?.objectiveId).toBe("rust-ownership");
    }
  });

  it("throws if the session has no curriculum configured", async () => {
    const engine = makeEngine();
    const llm: Explainer = { complete: jest.fn<Explainer["complete"]>() };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>() };
    const session = new TutorSession(engine, llm, memory);

    await expect(session.checkIn("student-1", "rust-ownership", "code")).rejects.toThrow(/requires a curriculum/);
  });

  it("throws on an unknown objectiveId rather than silently doing nothing", async () => {
    const engine = makeEngine();
    const llm: Explainer = { complete: jest.fn<Explainer["complete"]>() };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>() };
    const curriculum = new CurriculumGraph(objectives);
    const session = new TutorSession(engine, llm, memory, { curriculum, learningEvents: store, track: "rust" });

    await expect(session.checkIn("student-1", "does-not-exist", "code")).rejects.toThrow(/unknown objectiveId/);
  });

  it("never calls the LLM when the objective's own reference chunks aren't actually indexed", async () => {
    const engine = makeEngine(); // only indexes rust-book-0/1
    const complete = jest.fn<Explainer["complete"]>();
    const llm: Explainer = { complete };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>() };
    const staleObjective: CurriculumObjective = {
      id: "rust-ghost", track: "rust", unitId: "rust-ghost", bloomLevel: "understand",
      statement: "A stale objective pointing at a chunk that no longer exists.",
      sourceDocIds: ["rust-book-999"], prerequisiteObjectiveIds: [],
    };
    const curriculum = new CurriculumGraph([...objectives, staleObjective]);
    const session = new TutorSession(engine, llm, memory, { curriculum, learningEvents: store, track: "rust" });

    const result = await session.checkIn("student-1", "rust-ghost", "code");
    expect(result.kind).toBe("refused");
    expect(complete).not.toHaveBeenCalled();
  });

  it("strips the ASSESSMENT line from what the student sees and records a real independent_success event", async () => {
    const engine = makeEngine();
    const llm: Explainer = {
      complete: jest.fn<Explainer["complete"]>().mockResolvedValue("This correctly demonstrates ownership.\n\nASSESSMENT: satisfied"),
    };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined) };
    const curriculum = new CurriculumGraph(objectives);
    const session = new TutorSession(engine, llm, memory, { curriculum, learningEvents: store, track: "rust" });

    const result = await session.checkIn("student-1", "rust-ownership", "fn main() {}");
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.text).toBe("This correctly demonstrates ownership.");
      expect(result.text).not.toContain("ASSESSMENT");
    }

    const events = store.query({ entityId: "student-1", objectiveId: "rust-ownership" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "independent_success", source: "checkin_dialog", track: "rust" });
  });

  it("maps partial and not_satisfied assessments to their own outcomes", async () => {
    const curriculum = new CurriculumGraph(objectives);

    const partialLlm: Explainer = { complete: jest.fn<Explainer["complete"]>().mockResolvedValue("Getting there.\nASSESSMENT: partial") };
    const partialMemory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined) };
    const partialSession = new TutorSession(makeEngine(), partialLlm, partialMemory, { curriculum, learningEvents: store, track: "rust" });
    await partialSession.checkIn("student-partial", "rust-ownership", "code");
    expect(store.query({ entityId: "student-partial" })[0].outcome).toBe("partial");

    const failLlm: Explainer = { complete: jest.fn<Explainer["complete"]>().mockResolvedValue("Not quite.\nASSESSMENT: not_satisfied") };
    const failMemory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined) };
    const failSession = new TutorSession(makeEngine(), failLlm, failMemory, { curriculum, learningEvents: store, track: "rust" });
    await failSession.checkIn("student-fail", "rust-ownership", "code");
    expect(store.query({ entityId: "student-fail" })[0].outcome).toBe("failure");
  });

  it("records nothing, and does not throw, when the LLM omits a valid ASSESSMENT line", async () => {
    const engine = makeEngine();
    const llm: Explainer = { complete: jest.fn<Explainer["complete"]>().mockResolvedValue("Feedback with no assessment marker at all.") };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined) };
    const curriculum = new CurriculumGraph(objectives);
    const session = new TutorSession(engine, llm, memory, { curriculum, learningEvents: store, track: "rust" });

    const result = await session.checkIn("student-1", "rust-ownership", "code");
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.text).toBe("Feedback with no assessment marker at all.");
    }
    expect(store.query({ entityId: "student-1" })).toHaveLength(0);
  });

  it("a recorded checkIn event immediately advances nextSuggestion - code writes before the frontier is queried", async () => {
    const llm: Explainer = { complete: jest.fn<Explainer["complete"]>().mockResolvedValue("Correct.\nASSESSMENT: satisfied") };
    const memory: InteractionRecorder = { recordInteraction: jest.fn<InteractionRecorder["recordInteraction"]>().mockResolvedValue(undefined) };
    const curriculum = new CurriculumGraph(objectives);
    const session = new TutorSession(makeEngine(), llm, memory, { curriculum, learningEvents: store, track: "rust" });

    // Before any check-in, the frontier is still at the root.
    expect(curriculum.computeFrontier("rust", createIsSatisfied(store, "student-1")).map((o) => o.id)).toEqual(["rust-ownership"]);

    const result = await session.checkIn("student-1", "rust-ownership", "code");
    // A "satisfied" check-in writes the event, and the SAME call's own nextSuggestion already
    // reflects it - the frontier has moved on to the next objective by the time this returns.
    if (result.kind === "answer") expect(result.nextSuggestion?.objectiveId).toBe("rust-structs");
  });
});
