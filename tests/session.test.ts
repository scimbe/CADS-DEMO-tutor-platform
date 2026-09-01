import { jest } from "@jest/globals";
import { Bm25Retriever } from "../src/bm25.js";
import { GroundingEngine } from "../src/ground.js";
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
});
