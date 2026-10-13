// Authority lookup helpers — used by the YouTube channel-page resolver
// to consolidate dupes WITHOUT an API call when the user also bookmarked
// videos by the same channel.
import type { DB } from "./db.js";

export interface AuthorityRow {
  id: string;
  preferred: string;
  external_ids: Record<string, string>;
}

// Find a creator authority whose youtube_custom_url matches the given handle.
// Handle is normalized (lowercase, leading @ stripped) before comparison.
// Returns null if no match.
export function findYoutubeAuthorityByHandle(db: DB, handle: string): AuthorityRow | null {
  const normHandle = handle.toLowerCase().replace(/^@/, "");
  if (!normHandle) return null;

  // Iterate authorities (typically <100 per source); SQLite has no built-in
  // JSON path queries portable across versions, so we iterate in JS.
  const rows = db.prepare(`
    SELECT id, preferred, external_ids_json FROM authorities
    WHERE type = 'creator' AND source = 'youtube'
  `).all() as Array<{ id: string; preferred: string; external_ids_json: string | null }>;

  for (const r of rows) {
    if (!r.external_ids_json) continue;
    let ext: Record<string, string>;
    try { ext = JSON.parse(r.external_ids_json); } catch { continue; }
    const cu = ext.youtube_custom_url;
    if (!cu) continue;
    const normCu = cu.toLowerCase().replace(/^@/, "");
    if (normCu === normHandle) {
      return { id: r.id, preferred: r.preferred, external_ids: ext };
    }
  }
  return null;
}
