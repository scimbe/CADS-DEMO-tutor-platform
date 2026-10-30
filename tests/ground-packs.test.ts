import { readFileSync } from "node:fs";
import path from "node:path";
import { Bm25Retriever } from "../src/bm25.js";
import { GroundingEngine } from "../src/ground.js";
import type { Chunk, Source } from "../src/types.js";

function engineFor(pack: string) {
  const dir = path.join("content-packs", pack);
  const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf-8"));
  const engine = new GroundingEngine(new Bm25Retriever(), { relevanceThreshold: read("manifest.json").relevanceThreshold });
  engine.loadSources(read("sources.json") as Source[]);
  engine.indexChunks(read("index.json") as Chunk[]);
  return engine;
}

describe("real content packs", () => {
  const cases: Array<[string, string[], string[]]> = [
    [
      "rust",
      [
        "What is ownership?",
        "Was ist Ownership in Rust?",
        "What is a trait?",
        "Explain lifetimes",
        "what does match do in rust",
        "what is a generic function in rust",
      ],
      [
        "What is the capital of France?",
        "How do I bake a chocolate cake?",
        "pasta carbonara recipe",
        "how to play chess",
        "what are smart pointers",
        "how do threads work",
        "async await in rust",
        "how do macros work",
        "what is unsafe code",
      ],
    ],
    [
      "javascript",
      ["What is a closure?", "Was ist eine Closure?", "what is hoisting"],
      ["What is the Python GIL?", "pizza recipe", "how does the fetch api work"],
    ],
    ["firmware", [], ["best pizza topping recipe"]],
  ];

  it.each(cases)("%s: basic questions are answered, unrelated ones refused", (pack, good, bad) => {
    const engine = engineFor(pack);
    for (const q of good) expect([q, engine.ask(q).grounded]).toEqual([q, true]);
    for (const q of bad) expect([q, engine.ask(q).grounded]).toEqual([q, false]);
  });

  it("cites the chapter that is about the question", () => {
    const answer = engineFor("rust").ask("What is ownership?");
    expect(answer.citations[0].chunk.url).toContain("ch04");
  });
});
