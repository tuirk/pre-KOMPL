// Authority resolution — Layer 1 only: exact, normalized, alias-table.
// No fuzzy, no embedding, no LLM. See /pre-kompl-spec/architecture/authorities.md.
import type { DB } from "./db.js";
import type { Source } from "./types.js";
import { randomUUID } from "node:crypto";

export function authorityIdForCreator(source: Source, externalId: string): string {
  // E.g., auth_cre_yt_UC..., auth_cre_gh_karpathy, auth_cre_tw_RoundtableSpace, auth_cre_web_<slug>
  const safeId = externalId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `auth_cre_${shortSource(source)}_${safeId}`;
}

function shortSource(source: Source): string {
  return ({ youtube: "yt", github: "gh", twitter: "tw", web: "web" } as const)[source];
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// Find-or-create a creator authority. Layer 1 only.
// Returns the authority_id (creates row if it didn't exist).
export function findOrCreateCreatorAuthority(
  db: DB,
  source: Source,
  preferredName: string,
  externalIdForSlug: string,
  extras?: {
    variants?: string[];
    external_ids?: Record<string, string>;
    description?: string;
  }
): string {
  const id = authorityIdForCreator(source, externalIdForSlug);
  const now = Date.now();

  // 1. Exact ID match (this is also the dedup key — same externalId always lands here)
  const existing = db.prepare("SELECT id FROM authorities WHERE id = ?").get(id);
  if (existing) return id;

  // 2. Exact preferred match within same source
  const byPref = db.prepare(
    "SELECT id FROM authorities WHERE type = 'creator' AND source = ? AND preferred = ?"
  ).get(source, preferredName) as { id: string } | undefined;
  if (byPref) {
    // Different externalId, same preferred string — likely a real ambiguity (e.g., handle reuse).
    // Conservative: create new authority with the new ID. Bestie can manually merge later.
    // Fall through to create.
  }

  // 3. Normalized match within same source (catches case/punct variants)
  // Skipped for v0 — exact-match-by-id is enough for first-pass coverage.

  // 4. Alias table check — skipped for v0 (no UI to populate yet)

  // 5. Create new
  db.prepare(`
    INSERT INTO authorities (
      id, type, source, preferred, variants_json,
      broader_ids_json, narrower_ids_json,
      scope_note, external_ids_json, baseline_subjects_json,
      created_at, updated_at
    )
    VALUES (?, 'creator', ?, ?, ?, '[]', '[]', NULL, ?, '[]', ?, ?)
  `).run(
    id,
    source,
    preferredName,
    JSON.stringify(extras?.variants ?? []),
    extras?.external_ids ? JSON.stringify(extras.external_ids) : null,
    now,
    now
  );
  return id;
}

export function newWorkId(): string {
  return `wrk_${randomUUID().slice(0, 12)}`;
}

export function newItemId(): string {
  return `itm_${randomUUID().slice(0, 12)}`;
}

export function newErrorId(): string {
  return `err_${randomUUID().slice(0, 12)}`;
}

// Create a fresh Work for a new Instance. Per spec: always create, never match.
// Manual merging is the only path to combine Works.
export function createWorkForInstance(
  db: DB,
  title: string | null,
  description: string | null
): string {
  const id = newWorkId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO works (id, title, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, title, description, now, now);
  return id;
}
