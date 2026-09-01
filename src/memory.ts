import type { RecalledInteraction, StudentMemoryOptions } from "student-memory";

/**
 * Per-student interaction history for CaDS Tutor, backed by
 * CADS-DEMO-student-memory (LanceDB + local ONNX embeddings, no network call,
 * no API key). This is deliberately a thin wrapper, not a redesign - the
 * upstream package already has the boundary that matters baked in structurally
 * (entityId is a prefilter, so one student's recall can never surface another
 * student's rows).
 *
 * Scope boundary with GroundingEngine (ground.ts), which this class does NOT
 * touch: GroundingEngine answers "what is true", sourced only from cited
 * reference material - that's the non-negotiable rule this whole platform
 * exists to enforce. TutorMemory answers "what has this student and I already
 * talked about" - dialog continuity, not language/domain facts. A recalled
 * interaction is conversational context handed to the model alongside a
 * GroundedAnswer's citations, never a substitute for them.
 *
 * `student-memory` is a peerDependency, not a hard dependency - see
 * package.json. Found live, not hypothetically: a consumer that only wants
 * TutorSession's grounding+dialog loop and doesn't (yet) use
 * recallSimilarInteractions was pulling in ~960MB of onnxruntime-node/
 * onnxruntime-web/@lancedb (the real embedding+vector-DB machinery behind
 * recall) just because this file had a top-level `import { StudentMemory }
 * from "student-memory"` - npm resolves a listed dependency's install weight
 * regardless of whether the importing code path ever runs. Since
 * recallSimilarInteractions has no caller anywhere in this codebase yet (see
 * session.ts's own comment on why - that decision hasn't been made), that
 * weight was buying zero exercised functionality for that consumer. The
 * `import type` above costs nothing at runtime (erased by tsc); the real
 * class is loaded lazily below, on first actual use, so a consumer that
 * genuinely doesn't need memory can skip installing the peer entirely and
 * TutorSession still works via its own InteractionRecorder structural
 * interface - see session.ts, which never imported this class directly.
 */
export class TutorMemory {
  private readonly dbPath: string;
  private memoryPromise: Promise<InstanceType<typeof import("student-memory").StudentMemory>> | undefined;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private async connect() {
    if (!this.memoryPromise) {
      this.memoryPromise = import("student-memory").then(({ StudentMemory }) => {
        const options: StudentMemoryOptions = { dbPath: this.dbPath };
        return new StudentMemory(options);
      });
    }
    return this.memoryPromise;
  }

  async recordInteraction(studentId: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    const memory = await this.connect();
    await memory.record(studentId, { text, metadata });
  }

  async recallSimilarInteractions(studentId: string, queryText: string, topK = 3): Promise<RecalledInteraction[]> {
    const memory = await this.connect();
    return memory.recall(studentId, queryText, topK);
  }
}
