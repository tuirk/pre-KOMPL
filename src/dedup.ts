// Dedup logic — Item composite keys vary per source (see the README pipeline table).
// The seen-set (loaded from db.ts) handles Instance-level dedup.
// Item-level dedup is a per-source composite lookup (checkItemComposite in sources/web.ts).
import type { DB as Database } from "./db.js";

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

  // Multiple matches in multiple folders: ambiguous. By design, skip if folder matches
  // an existing Item; create new if it's a genuinely-new folder. Caller handles this
  // by checking the result is null (we return null here for the multi-match case).
  return null;
}
