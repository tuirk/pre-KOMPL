// SQLite layer using better-sqlite3 (matches Kompl's architecture).
// Single-writer single-process. Native build ships SQLite with FTS5 enabled.
// Schema is created idempotently on every open via CREATE TABLE IF NOT EXISTS.
import Database from "better-sqlite3";
import { CANONICALIZATION_RULES_VERSION } from "./config.js";

export type DB = Database.Database;

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

-- ── Full-text search index over Instances ────────────────────────────────
-- Mirror of the searchable Instance content + linked authority + folder paths.
-- Maintained manually (DELETE+INSERT on every write site that touches an Instance
-- and on every Item write whose bookmark_folder_path contributes to an existing
-- Instance's row). Discovery-layer pattern: one BM25-ranked search across all
-- access points, with facet filtering applied in the outer query so BM25 order
-- is preserved.
--
-- Tokenizer: porter for stemming (memory/memories collapse), unicode61 for
-- non-ASCII (we have Norwegian and German titles in the corpus).
-- Status/source columns are UNINDEXED — stored for filtering but excluded
-- from the inverted index to keep it lean.
CREATE VIRTUAL TABLE IF NOT EXISTS instances_fts USING fts5(
  instance_id UNINDEXED,
  title,
  description,
  folder_paths,
  creator_name,
  url_canonical,
  source UNINDEXED,
  kind UNINDEXED,
  ingest_status UNINDEXED,
  partial_reason UNINDEXED,
  tokenize = 'porter unicode61'
);
`;

export function openDb(path: string): DB {
  const db = new Database(path);
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

// ── Full-text search index maintenance ─────────────────────────────────────
// Mirror an instance row into instances_fts. Idempotent (DELETE+INSERT).
// Reads live data from the instance row + linked items (for folder_paths)
// + linked creator authority (for creator_name including variants), so it
// stays in sync regardless of which fields the caller just changed.
//
// Every code path that INSERTs/UPDATEs an instance row must call this after
// the write. Same audit-trail safety net as Kompl's pages_fts maintenance.
export function upsertInstanceFts(db: DB, instanceId: string): void {
  const inst = db.prepare(
    `SELECT id, source, kind, url_canonical, title, description,
            creator_authority_id, ingest_status, partial_reason
     FROM instances WHERE id = ?`
  ).get(instanceId) as
    | {
        id: string; source: string; kind: string; url_canonical: string;
        title: string | null; description: string | null;
        creator_authority_id: string | null;
        ingest_status: string; partial_reason: string | null;
      }
    | undefined;
  if (!inst) {
    // Instance was deleted between caller's write and ours — defensive remove.
    removeInstanceFts(db, instanceId);
    return;
  }

  // Concatenate folder paths from every Item pointing at this Instance.
  // FTS rows are per-Instance, but folder context lives on Items (one Instance
  // can have multiple Items in different folders).
  const folderRows = db.prepare(
    `SELECT DISTINCT bookmark_folder_path FROM items
     WHERE instance_id = ? AND bookmark_folder_path != ''`
  ).all(instanceId) as Array<{ bookmark_folder_path: string }>;
  // Split pipe-separated folder paths into individual segments so FTS tokenizes
  // each segment ("Cyber DYOR|A.I.|Trading Agents" → "Cyber DYOR A.I. Trading Agents").
  const folder_paths = folderRows
    .map((r) => r.bookmark_folder_path.replace(/\|/g, " "))
    .join(" ");

  // Creator's preferred name + variants (authority cross-reference expansion at
  // index time, not query time — embedding the variants in the FTS row means
  // "ptl" matches Part Time Larry's content without runtime lookup).
  let creator_name = "";
  if (inst.creator_authority_id) {
    const auth = db.prepare(
      "SELECT preferred, variants_json FROM authorities WHERE id = ?"
    ).get(inst.creator_authority_id) as
      | { preferred: string; variants_json: string }
      | undefined;
    if (auth) {
      let variants: string[] = [];
      try { variants = JSON.parse(auth.variants_json); } catch { /* malformed JSON */ }
      creator_name = [auth.preferred, ...variants].filter(Boolean).join(" ");
    }
  }

  db.prepare("DELETE FROM instances_fts WHERE instance_id = ?").run(instanceId);
  db.prepare(
    `INSERT INTO instances_fts (
       instance_id, title, description, folder_paths, creator_name,
       url_canonical, source, kind, ingest_status, partial_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    inst.id,
    inst.title ?? "",
    inst.description ?? "",
    folder_paths,
    creator_name,
    inst.url_canonical,
    inst.source,
    inst.kind,
    inst.ingest_status,
    inst.partial_reason ?? ""
  );
}

export function removeInstanceFts(db: DB, instanceId: string): void {
  db.prepare("DELETE FROM instances_fts WHERE instance_id = ?").run(instanceId);
}

// Backfill helper for upgrade path. Walks every instance and rebuilds its FTS row.
// Idempotent — safe to run repeatedly. Used by `pre-kompl rebuild-fts` and tests.
export function rebuildInstancesFts(db: DB): number {
  const ids = db.prepare("SELECT id FROM instances").all() as Array<{ id: string }>;
  db.exec("DELETE FROM instances_fts");
  for (const { id } of ids) upsertInstanceFts(db, id);
  return ids.length;
}
