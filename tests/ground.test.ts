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

describe("GroundingEngine", () => {
  it("grounds an answer when a chunk clears the relevance threshold", () => {
    const engine = makeEngine();
    const answer = engine.ask("What is ownership in Rust?");
    expect(answer.grounded).toBe(true);
    expect(answer.citations[0].chunk.id).toBe("rust-book-0");
  });

  it("refuses instead of guessing when nothing indexed is relevant", () => {
    const engine = makeEngine();
    const answer = engine.ask("What is the capital of France?");
    expect(answer.grounded).toBe(false);
    expect(answer.citations).toHaveLength(0);
    expect(answer.refusalReason).toBeDefined();
  });

  it("throws if asked to build a prompt from an ungrounded answer", () => {
    const engine = makeEngine();
    const ungrounded = engine.ask("What is the capital of France?");
    expect(() => engine.buildGroundedPrompt("What is the capital of France?", ungrounded)).toThrow();
  });

  it("includes source title, license, and the chunk text in the grounded prompt", () => {
    const engine = makeEngine();
    const answer = engine.ask("What is ownership in Rust?");
    const prompt = engine.buildGroundedPrompt("What is ownership in Rust?", answer);
    expect(prompt).toContain("The Rust Programming Language");
    expect(prompt).toContain("MIT OR Apache-2.0");
    expect(prompt).toContain("memory safety guarantees");
  });

  it("a higher relevance threshold can turn a weak match into a refusal", () => {
    const strictEngine = makeEngine(50); // deliberately unreachable BM25 score for this tiny corpus
    const answer = strictEngine.ask("What is ownership in Rust?");
    expect(answer.grounded).toBe(false);
  });
});

describe("GroundingEngine.groundOnKnownChunks", () => {
  it("grounds directly on the given chunk ids, no retrieval involved", () => {
    const engine = makeEngine();
    const answer = engine.groundOnKnownChunks(["rust-book-1"]);
    expect(answer.grounded).toBe(true);
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0].chunk.id).toBe("rust-book-1");
  });

  it("preserves order and includes multiple known chunks", () => {
    const engine = makeEngine();
    const answer = engine.groundOnKnownChunks(["rust-book-1", "rust-book-0"]);
    expect(answer.grounded).toBe(true);
    expect(answer.citations.map((c) => c.chunk.id)).toEqual(["rust-book-1", "rust-book-0"]);
  });

  it("silently skips unknown chunk ids rather than throwing", () => {
    const engine = makeEngine();
    const answer = engine.groundOnKnownChunks(["rust-book-0", "does-not-exist"]);
    expect(answer.grounded).toBe(true);
    expect(answer.citations).toHaveLength(1);
  });

  it("refuses when every id is unknown or the list is empty", () => {
    const engine = makeEngine();
    expect(engine.groundOnKnownChunks([]).grounded).toBe(false);
    expect(engine.groundOnKnownChunks(["ghost-1", "ghost-2"]).grounded).toBe(false);
  });
});
