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
- **`session.ts`** — `TutorSession`: orchestrates one real student turn — grounding, then (only if
  grounded) the LLM explanation, then (only if the LLM call succeeded) recording the interaction to
  memory. Each gate is real, not cosmetic: an ungrounded question never reaches the LLM at all, and a
  failed LLM call never gets written to `TutorMemory` as though it were a real exchange. The result is
  a discriminated `TutorTurnResult`:

  ```ts
  type TutorTurnResult =
    | { kind: "refused"; reason: string }
    | { kind: "llm-error"; citations: RetrievedChunk[]; message: string }
    | { kind: "answer"; text: string; citations: RetrievedChunk[] };
  ```

  so a caller can `switch` on `kind` and handle "never asked the LLM", "asked and it failed", and "got
  a real answer" as three distinct, type-checked cases instead of inspecting error strings or null
  fields. `llm-error` still carries the citations, so a student sees the reference material even when
  the model itself is down.

  `TutorMemory` (`memory.ts`, wrapping [`CADS-DEMO-student-memory`](https://github.com/scimbe/CADS-DEMO-student-memory))
  exposes both `recordInteraction` and `recallSimilarInteractions`, but `TutorSession` only calls the
  former. That's deliberate, not an oversight: folding prior interactions into the grounded prompt is
  a real design decision — how much history, how stale it's allowed to be, whether conversational
  recall could ever get treated as a fact rather than context — that hasn't been made yet. Wiring it
  in now would have been a guess dressed up as a feature. `recallSimilarInteractions` is implemented
  and available for whichever tutor extension wants it; `session.ts` deliberately doesn't call it
  until that decision is made.

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
npm test                                    # 15 tests, all against real logic, no LLM needed
npm run ingest -- content-packs/rust        # fetches real chapters from github.com/rust-lang/book
npx tsc && node dist/cli/demo.js content-packs/rust "why do I need a reference instead of taking ownership"
```

### Running a real tutor turn (grounding + LLM + memory)

`src/cli/tutor.ts` drives the exact wiring a real tutor extension would use —
`GroundingEngine` + `LlmClient` + `TutorMemory` through `TutorSession` — against a live LLM endpoint,
not a mock:

```bash
npm run tutor -- content-packs/rust student-1 "why do I need a reference instead of taking ownership"
```

This needs a `.env` in the repo root (gitignored — never commit real credentials) with an
OpenAI-chat-compatible endpoint, e.g. a [litellm](https://github.com/BerriAI/litellm) proxy:

```
TUTOR_LLM_BASE_URL=https://your-litellm-proxy.example.com
TUTOR_LLM_API_KEY=your-api-key
TUTOR_LLM_MODEL=your-model-name
```

`LlmClient` (`src/llm.ts`) refuses to construct with a non-`https://` base URL — a plain-http proxy
URL already caused a real, hard-to-diagnose 401 in this project's own firmware-lab tutor (looked like
a bad credential, wasn't one), so that mistake fails loudly here instead of quietly.

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

This is no longer Phase 0's grounding-only engine. `TutorSession` closes the full loop —
grounding → LLM explanation → memory recording — and that loop has been run end to end for real: a
real question, real BM25 retrieval against ingested Rust Book content, a real HTTP call to a live LLM
endpoint, and a real interaction written to `TutorMemory`, not mocked at any stage. 15 passing tests
(the original grounding suite plus `TutorSession`'s three-case coverage: refused / llm-error /
answer), a working ingestion pipeline against live upstream content, and a verified `tutor` CLI turn.

Still not done: it isn't wired into either tutor extension yet, `recallSimilarInteractions` is
implemented but deliberately unused (see `session.ts` above), and the BM25 relevance threshold still
needs per-content-pack calibration, not a copy-pasted default (see above). See the
[full platform plan](https://claude.ai/code/artifact/67493cd9-2c7e-4922-85e4-256d5a7f7986) for what
comes next and what's still an open decision.
