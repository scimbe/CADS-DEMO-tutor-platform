import { Bm25Retriever } from "../src/bm25.js";
import type { Chunk } from "../src/types.js";

function chunk(id: string, text: string): Chunk {
  return { id, sourceId: "test", section: "test", url: "http://example.test", text };
}

describe("Bm25Retriever", () => {
  it("ranks the chunk that actually mentions the query term above one that doesn't", () => {
    const retriever = new Bm25Retriever();
    retriever.index([
      chunk("a", "Ownership is Rust's most unique feature and enables memory safety without a garbage collector."),
      chunk("b", "Structs let you create custom types by combining related values into one grouping."),
      chunk("c", "The borrow checker enforces ownership rules at compile time."),
    ]);

    const results = retriever.search("ownership memory safety", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.id).toBe("a");
  });

  it("returns nothing for a query with no matching terms at all", () => {
    const retriever = new Bm25Retriever();
    retriever.index([chunk("a", "Ownership is Rust's most unique feature.")]);

    const results = retriever.search("xylophone quokka", 3);
    expect(results).toHaveLength(0);
  });

  it("returns an empty index cleanly instead of throwing", () => {
    const retriever = new Bm25Retriever();
    retriever.index([]);
    expect(retriever.search("anything", 3)).toHaveLength(0);
  });
});
