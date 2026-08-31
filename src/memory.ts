import { StudentMemory } from "student-memory";
import type { RecalledInteraction } from "student-memory";

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
 */
export class TutorMemory {
  private readonly memory: StudentMemory;

  constructor(dbPath: string) {
    this.memory = new StudentMemory({ dbPath });
  }

  async recordInteraction(studentId: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.memory.record(studentId, { text, metadata });
  }

  async recallSimilarInteractions(studentId: string, queryText: string, topK = 3): Promise<RecalledInteraction[]> {
    return this.memory.recall(studentId, queryText, topK);
  }
}
