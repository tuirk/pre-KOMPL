// SQLite layer using Node's built-in node:sqlite.
// Single-writer single-process (matches Kompl's architecture rule).
// Schema is created idempotently on every open via CREATE TABLE IF NOT EXISTS.
import { DatabaseSync } from "node:sqlite";
import { CANONICALIZATION_RULES_VERSION } from "./config.js";

export type DB = DatabaseSync;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  native_id TEXT NOT NULL,
  url_canonical TEXT NOT NULL,
  title TEXT,
  description TEXT,
  source_payload_json TEXT,
  creator_authority_id TEXT,
  subject_authority_ids_json TEXT NOT NULL DEFAULT '[]',
  work_id TEXT NOT NULL,
  access_status TEXT NOT NULL DEFAULT 'unknown',
  is_archived_url INTEGER NOT NULL DEFAULT 0,
  ingest_status TEXT NOT NULL,
  partial_reason TEXT,
  fetched_at INTEGER NOT NULL,
  UNIQUE(source, native_id)
);

CREATE INDEX IF NOT EXISTS idx_instances_kind ON instances(kind);
CREATE INDEX IF NOT EXISTS idx_instances_creator ON instances(creator_authority_id);
CREATE INDEX IF NOT EXISTS idx_instances_work ON instances(work_id);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  instance_id TEXT,
  url_as_saved TEXT NOT NULL,
  url_canonical TEXT NOT NULL,
  save_date INTEGER NOT NULL,
  save_date_is_inferred INTEGER NOT NULL DEFAULT 0,
  bookmark_folder_path TEXT NOT NULL DEFAULT '',
  user_notes TEXT,
  source_export_file TEXT NOT NULL,
  ingested_at INTEGER NOT NULL,
  ingest_status TEXT NOT NULL,
  ingest_error_id TEXT
);

-- Item composite uniqueness varies per source.
-- We don't enforce via DB UNIQUE (would need per-source partial indexes).
-- The seen-set + buildItemKey() composite handles dedup at app layer.
CREATE INDEX IF NOT EXISTS idx_items_instance ON items(instance_id);
CREATE INDEX IF NOT EXISTS idx_items_save_date ON items(save_date);
CREATE INDEX IF NOT EXISTS idx_items_folder ON items(bookmark_folder_path);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(ingest_status);

CREATE TABLE IF NOT EXISTS authorities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT,
  preferred TEXT NOT NULL,
  variants_json TEXT NOT NULL DEFAULT '[]',
  broader_ids_json TEXT NOT NULL DEFAULT '[]',
  narrower_ids_json TEXT NOT NULL DEFAULT '[]',
  scope_note TEXT,
  external_ids_json TEXT,
  baseline_subjects_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_authorities_type ON authorities(type);
CREATE INDEX IF NOT EXISTS idx_authorities_preferred ON authorities(preferred);

-- Alias table for manual merges (bestie merges duplicates via UI in v1+; v0 unused).
CREATE TABLE IF NOT EXISTS aliases (
  alias_text TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  PRIMARY KEY (alias_text, authority_id)
);

CREATE TABLE IF NOT EXISTS ingestion_errors (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  raw_input TEXT NOT NULL,
  source_export_file TEXT NOT NULL,
  classification_attempt TEXT,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  exception_traceback TEXT,
  item_id TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolution_action TEXT,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_errors_resolved ON ingestion_errors(resolved);
CREATE INDEX IF NOT EXISTS idx_errors_type ON ingestion_errors(error_type);
`;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);

  // Record canonicalization rules version (one-time).
  const existing = db
    .prepare("SELECT value FROM meta WHERE key = 'canonicalization_rules_version'")
    .get() as { value: string } | undefined;
  if (!existing) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('canonicalization_rules_version', ?)"
    ).run(String(CANONICALIZATION_RULES_VERSION));
  } else if (Number(existing.value) !== CANONICALIZATION_RULES_VERSION) {
    throw new Error(
      `Canonicalization rules version mismatch: DB has v${existing.value}, code is v${CANONICALIZATION_RULES_VERSION}. ` +
        `A migration is required (see /pre-kompl-spec/architecture/access-points.md#canonicalization-rules-are-versioned).`
    );
  }
  return db;
}

// Load the seen set for Instance dedup. O(N) at start; O(1) per check after.
export function loadSeenInstances(db: DB): Set<string> {
  const rows = db
    .prepare("SELECT source, native_id FROM instances")
    .all() as Array<{ source: string; native_id: string }>;
  return new Set(rows.map((r) => `${r.source}\u0000${r.native_id}`));
}

export function instanceSeenKey(source: string, nativeId: string): string {
  return `${source}\u0000${nativeId}`;
}
