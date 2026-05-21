// Dedup logic — Item composite keys vary per source (see /pre-kompl-spec/architecture/dedup.md).
// The seen-set (loaded from db.ts) handles Instance-level dedup.
// Item-level dedup uses (instance_id, composite-key) and falls back to a DB lookup.
import type { Source } from "./types.js";
import type { DB as Database } from "./db.js";

// Composite key the spec defines for each source.
// Returned as a string so SQL queries and JS Sets share representation.
export function buildItemCompositeKey(
  source: Source,
  instanceId: string,
  urlAsSaved: string,
  saveDate: number,
  folderPath: string
): string {
  const SEP = "\u0001";
  switch (source) {
    case "twitter":
      // (instance_id, url_as_saved) — no save_date, no folder
      return [instanceId, urlAsSaved].join(SEP);
    case "youtube":
    case "github":
      // (instance_id, url_as_saved, save_date)
      return [instanceId, urlAsSaved, saveDate].join(SEP);
    case "web":
      // (instance_id, url_as_saved, save_date, bookmark_folder_path)
      return [instanceId, urlAsSaved, saveDate, folderPath].join(SEP);
  }
}

// Load existing item composite keys for fast in-run dedup.
// We compute the key from row data so it stays consistent with builder above.
export function loadSeenItems(db: Database, instanceSource: Map<string, Source>): Set<string> {
  const rows = db
    .prepare(
      "SELECT instance_id, url_as_saved, save_date, bookmark_folder_path FROM items WHERE instance_id IS NOT NULL"
    )
    .all() as Array<{
      instance_id: string;
      url_as_saved: string;
      save_date: number;
      bookmark_folder_path: string;
    }>;
  const seen = new Set<string>();
  for (const r of rows) {
    const src = instanceSource.get(r.instance_id);
    if (!src) continue; // orphan; shouldn't happen
    seen.add(
      buildItemCompositeKey(src, r.instance_id, r.url_as_saved, r.save_date, r.bookmark_folder_path)
    );
  }
  return seen;
}

// Map of instance_id → source, used by loadSeenItems and folder-rename detection.
export function loadInstanceSourceMap(db: Database): Map<string, Source> {
  const rows = db
    .prepare("SELECT id, source FROM instances")
    .all() as Array<{ id: string; source: string }>;
  return new Map(rows.map((r) => [r.id, r.source as Source]));
}

// Folder-rename detection: when an Item exists with same (instance_id, url_as_saved, save_date)
// but different bookmark_folder_path, we UPDATE the existing row rather than creating a new one.
// Web only; Twitter has no save_date in the composite.
export function findFolderRenameCandidate(
  db: Database,
  instanceId: string,
  urlAsSaved: string,
  saveDate: number,
  newFolderPath: string
): string | null {
  const rows = db
    .prepare(
      `SELECT id, bookmark_folder_path FROM items
       WHERE instance_id = ? AND url_as_saved = ? AND save_date = ?`
    )
    .all(instanceId, urlAsSaved, saveDate) as Array<{
      id: string;
      bookmark_folder_path: string;
    }>;

  if (rows.length === 0) return null;

  // Exact match already exists — no rename, would be no-op (dedup hit upstream)
  if (rows.some((r) => r.bookmark_folder_path === newFolderPath)) return null;

  // Exactly one match with different folder → rename
  if (rows.length === 1) return rows[0].id;

  // Multiple matches in multiple folders: ambiguous. Per spec, skip if folder matches
  // an existing Item; create new if it's a genuinely-new folder. Caller handles this
  // by checking the result is null (we return null here for the multi-match case).
  return null;
}
