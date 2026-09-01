import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { BloomLevel } from "./types.js";
import type { BloomPromptMode } from "./bloom.js";

/**
 * The unified event log the backbone architecture's synthesis phase merged two
 * independently-proposed designs into (see the published architecture doc): one append-only
 * table, one canonical set of column names. Every other backbone table (mastery, XP, badges)
 * is a derived view recomputed from this - nothing here is ever overwritten.
 *
 * Backed by node:sqlite (built into Node 22+, no new dependency, no new hosting
 * coordination) - a real relational store for exact-match queries and joins, the shape this
 * data actually needs, as opposed to TutorMemory's LanceDB (chosen for semantic similarity
 * search, a different problem). This is a v0 on the same storage-choice principle bm25.ts's
 * own comment already documents for retrieval: ship something real and fully testable now,
 * with an interface stable enough to swap the backing store later without a redesign.
 */

export type LearningEventSource =
  | "chat_answer"
  | "ide_diagnostic"
  | "task_run"
  | "terminal_exec"
  | "checkin_dialog"
  | "explicit_quiz"
  | "tool_check";

export type LearningEventOutcome = "independent_success" | "assisted_success" | "failure" | "abandoned" | "partial";

export interface LearningEventInput {
  entityId: string;
  sessionId: string;
  track: string;
  /** Nullable: not every event (e.g. a raw diagnostic) is tied to a curriculum objective yet. */
  objectiveId?: string;
  unitId?: string;
  bloomLevel: BloomLevel;
  exchangeType: BloomPromptMode | null;
  source: LearningEventSource;
  /** 0-3, 0 = no Socratic ladder involved (explain mode, or not yet resolved). Comes straight
   * from bloom.ts's buildTutorPrompt() return value - see its own doc comment. */
  hintTierReached: number;
  outcome: LearningEventOutcome;
  xpAwarded?: number;
  artifactRef?: string;
  groundingDocIds?: string[];
}

export interface LearningEvent extends LearningEventInput {
  id: string;
  timestamp: number;
}

export interface LearningEventFilter {
  entityId?: string;
  track?: string;
  objectiveId?: string;
  since?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS learning_event (
  id                  TEXT PRIMARY KEY,
  entityId            TEXT NOT NULL,
  sessionId           TEXT NOT NULL,
  track               TEXT NOT NULL,
  objectiveId         TEXT,
  unitId              TEXT,
  bloomLevel          TEXT NOT NULL,
  exchangeType        TEXT,
  source              TEXT NOT NULL,
  hintTierReached     INTEGER NOT NULL,
  outcome             TEXT NOT NULL,
  xpAwarded           INTEGER,
  artifactRef         TEXT,
  groundingDocIds     TEXT,
  timestamp           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_event_entity ON learning_event(entityId);
CREATE INDEX IF NOT EXISTS idx_learning_event_entity_objective ON learning_event(entityId, objectiveId);
`;

export class LearningEventStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  /** Appends one event. Never updates or deletes - every derived table is recomputed from the
   * full history, per the architecture doc's own "never overwrite evidence" rule. `now` is
   * injectable for tests; defaults to the real clock. */
  record(input: LearningEventInput, now: number = Date.now()): LearningEvent {
    const event: LearningEvent = { ...input, id: randomUUID(), timestamp: now };
    const stmt = this.db.prepare(`
      INSERT INTO learning_event
        (id, entityId, sessionId, track, objectiveId, unitId, bloomLevel, exchangeType,
         source, hintTierReached, outcome, xpAwarded, artifactRef, groundingDocIds, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.id,
      event.entityId,
      event.sessionId,
      event.track,
      event.objectiveId ?? null,
      event.unitId ?? null,
      event.bloomLevel,
      event.exchangeType,
      event.source,
      event.hintTierReached,
      event.outcome,
      event.xpAwarded ?? null,
      event.artifactRef ?? null,
      event.groundingDocIds ? JSON.stringify(event.groundingDocIds) : null,
      event.timestamp
    );
    return event;
  }

  /** Reads events matching every provided filter field, oldest first - the order every
   * recency-weighted mastery/streak calculation needs. */
  query(filter: LearningEventFilter = {}): LearningEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.entityId) {
      clauses.push("entityId = ?");
      params.push(filter.entityId);
    }
    if (filter.track) {
      clauses.push("track = ?");
      params.push(filter.track);
    }
    if (filter.objectiveId) {
      clauses.push("objectiveId = ?");
      params.push(filter.objectiveId);
    }
    if (filter.since !== undefined) {
      clauses.push("timestamp >= ?");
      params.push(filter.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM learning_event ${where} ORDER BY timestamp ASC`).all(...(params as never[]));
    return rows.map((r) => rowToEvent(r as Record<string, unknown>));
  }

  close(): void {
    this.db.close();
  }
}

function rowToEvent(row: Record<string, unknown>): LearningEvent {
  return {
    id: row.id as string,
    entityId: row.entityId as string,
    sessionId: row.sessionId as string,
    track: row.track as string,
    objectiveId: (row.objectiveId as string | null) ?? undefined,
    unitId: (row.unitId as string | null) ?? undefined,
    bloomLevel: row.bloomLevel as BloomLevel,
    exchangeType: row.exchangeType as BloomPromptMode | null,
    source: row.source as LearningEventSource,
    hintTierReached: row.hintTierReached as number,
    outcome: row.outcome as LearningEventOutcome,
    xpAwarded: (row.xpAwarded as number | null) ?? undefined,
    artifactRef: (row.artifactRef as string | null) ?? undefined,
    groundingDocIds: row.groundingDocIds ? (JSON.parse(row.groundingDocIds as string) as string[]) : undefined,
    timestamp: row.timestamp as number,
  };
}
