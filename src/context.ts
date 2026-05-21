// Per-run state shared across all source pipelines.
// Avoids passing 7 arguments everywhere; tidier than module-level globals.
import type { DB } from "./db.js";
import type { Config } from "./config.js";
import type { Source, ErrorType, IngestionError, IngestSummary, Kind, IngestStatus } from "./types.js";
import { instanceSeenKey } from "./db.js";
import { newErrorId } from "./authorities.js";

export class IngestContext {
  // Quota tracking
  youtubeUnitsUsed = 0;
  githubRequestsUsed = 0;
  firecrawlCreditsUsed = 0;

  // Counters
  itemsCreated = 0;
  instancesCreated = 0;
  authoritiesTouched = new Set<string>();
  bySource: Record<Source, number> = { youtube: 0, github: 0, twitter: 0, web: 0 };
  byStatus: Record<IngestStatus, number> = { ok: 0, partial: 0, error: 0 };

  filesProcessed = 0;
  filesSkipped = 0;

  // For progress display
  onProgress: ((event: ProgressEvent) => void) | null = null;

  constructor(public db: DB, public config: Config, public seenInstances: Set<string>) {}

  hasSeenInstance(source: Source, nativeId: string): boolean {
    return this.seenInstances.has(instanceSeenKey(source, nativeId));
  }
  markInstanceSeen(source: Source, nativeId: string): void {
    this.seenInstances.add(instanceSeenKey(source, nativeId));
  }

  recordError(args: {
    source: Source | "unclassified";
    raw_input: string;
    source_export_file: string;
    classification_attempt: string | null;
    error_type: ErrorType;
    error_message: string;
    exception_traceback?: string;
    item_id?: string;
  }): string {
    const id = newErrorId();
    this.db.prepare(`
      INSERT INTO ingestion_errors (
        id, occurred_at, source, raw_input, source_export_file, classification_attempt,
        error_type, error_message, exception_traceback, item_id, resolved
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id, Date.now(),
      args.source, args.raw_input, args.source_export_file, args.classification_attempt,
      args.error_type, args.error_message,
      args.exception_traceback ?? null,
      args.item_id ?? null
    );
    this.byStatus.error++;
    return id;
  }

  emit(event: ProgressEvent): void {
    if (this.onProgress) this.onProgress(event);
  }
}

export type ProgressEvent =
  | { kind: "file_scan"; path: string; type: string; entries?: number; reason?: string }
  | { kind: "pipeline_start"; source: Source; total: number }
  | { kind: "pipeline_progress"; source: Source; done: number; total: number }
  | { kind: "pipeline_done"; source: Source; created: number; deduped: number }
  | { kind: "ingest_done"; summary: IngestSummary };
