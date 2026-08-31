# CADS-DEMO-tutor-platform

The shared grounding/citation engine behind **CaDS Tutor** — the same tutor persona for both the
STM32 firmware tutor (in [CADS-DEMO-firmware-lab](https://github.com/scimbe/CADS-DEMO-firmware-lab))
and a planned Rust tutor.

## The non-negotiable rule

**No fact about a language or its concepts may come from the LLM itself.** Everything the tutor
teaches must trace back to an indexed reference source with a real URL and license. The model's job
is dialog and explanation — never being the source of truth for what's actually true. See
[`src/ground.ts`](src/ground.ts): `GroundingEngine` never calls an LLM itself; it decides, from
retrieval scores alone, whether a question is answerable from what's indexed, and if not, returns a
fixed refusal rather than a green light to guess.

## How it works

```
reference docs (real, licensed) --chunk--> Chunk[] --index--> Retriever --search--> RetrievedChunk[]
                                                                              |
                                                            score >= threshold?
                                                                    |
                                          yes: GroundedAnswer{grounded:true, citations}
                                          no:  GroundedAnswer{grounded:false, refusalReason}
```

- **`chunk.ts`** — splits markdown along heading boundaries, falling back to sentence- then
  character-level splitting for any single paragraph that's still too long on its own (a real bug
  found by the tests, not a hypothetical — see git history).
- **`bm25.ts`** — a plain, dependency-free BM25 retriever. No embeddings, no API key, no network
  call needed to answer a query. Chosen deliberately for v0: it makes the engine's core correctness
  fully unit-testable without mocking a model, and BM25 over a controlled documentation corpus is a
  legitimate, well-established retrieval technique on its own, not a placeholder. The `Retriever`
  interface is designed so a dense/embedding retriever can be added later — combined with BM25 or
  standalone — without redesigning anything upstream.
- **`ground.ts`** — `GroundingEngine`: ties a `Retriever` to a relevance threshold and produces
  `GroundedAnswer`s, plus `buildGroundedPrompt()`, which formats retrieved chunks (with source,
  license, section) into the *only* material an LLM is allowed to answer from.

## A real, honest limitation found while building this

The relevance threshold is an **absolute BM25 score**, and BM25 scores are corpus- and
query-length-dependent — there's no universal "good" number. Concretely: with the default demo
threshold set too low, the question *"how do I write a multithreaded async web server in rust"*
against a corpus that only covers ownership/borrowing/structs came back `grounded: true` — the word
"server" happens to appear in the ownership chapter's restaurant-analogy example, and that alone was
enough to clear a threshold of 1.0. Raising it to 5.0 (calibrated against this specific corpus's real
score distribution — see `src/cli/demo.ts`) fixed it. **This means the threshold needs real
calibration per content pack, not a copy-pasted default**, and is exactly the kind of thing that
needs verification against each pack's actual indexed content before shipping, the same way this
project's own firmware work never trusts an untested assumption.

## Try it yourself

```bash
npm install
npm test                                    # 12 tests, all against real logic, no LLM needed
npm run ingest -- content-packs/rust        # fetches real chapters from github.com/rust-lang/book
npx tsc && node dist/cli/demo.js content-packs/rust "why do I need a reference instead of taking ownership"
```

## Content packs

| Pack | Sources | Status |
|---|---|---|
| `content-packs/rust/` | The Rust Book, Rust by Example, Rustlings, Comprehensive Rust, The Embedded Rust Book — all MIT/Apache-2.0/CC-BY-4.0, verified before use | 3 chapters ingested (ownership, borrowing, structs) as a proof of concept; extending to the full milestone map is mechanical |
| `content-packs/firmware/` | This project's own docs (MIT-licensed, cads-zero itself) | Not yet ingested |

**On RM0090 (STM32 reference manual)**: it's copyrighted by STMicroelectronics. Freely downloadable
for reference, but not something to bulk-copy verbatim into a public repo without checking
redistribution rights first — that check hasn't been done. The firmware content pack's v0 sources are
therefore this project's own already-MIT-licensed docs, not the manual itself; specific register
facts should cite the manual by section/URL rather than reproducing its text wholesale, until that's
actually verified.

## Status

Phase 0 (this repo) is real and tested, not a stub — 12 passing tests, a working ingestion pipeline
against live upstream content, and a demonstrated grounded Q&A round trip. It is not yet wired into
either tutor extension. See the [full platform plan](https://claude.ai/code/artifact/67493cd9-2c7e-4922-85e4-256d5a7f7986)
for what comes next and what's still an open decision.
