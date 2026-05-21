// Catalog search — discovery-layer primitive.
//
// Pattern (post-OPAC 2.0 standard): one BM25-ranked FTS5 query across all
// access points (title, description, folder paths, creator name, URL), with
// facet filters applied in the outer query so BM25 order is preserved.
// Response envelope includes facet counts over the result set so callers can
// suggest refinements without a second round-trip. Zero-result fallback
// drops the rarest token and retries.
//
// References:
//   - Kompl's pages_fts pattern (FTS5 + prefix-match + sanitize + BM25)
//   - OPAC 2.0 / discovery layer (Code4Lib Journal article on CatalogWS, 2007)
//   - Tagliacozzo & Kochen 1970 (known-item vs subject-search dichotomy)
//   - Ranganathan PMEST (folders are the user's personal pre-coordinate facet)

import type { DB } from "./db.js";

export interface SearchOptions {
  limit?: number;            // results returned; default 20, max 100
  facet_filters?: {
    source?: string[];         // ['github', 'youtube', ...]
    kind?: string[];           // ['video', 'github-repo', 'article', ...]
    folder_prefix?: string;    // case-sensitive prefix match on folder path
    ingest_status?: string[];  // default ['ok'] — pass [] to disable
    partial_reason?: string[]; // useful for cleanup queries ('dead_link')
  };
}

export interface SearchHit {
  instance_id: string;
  source: string;
  kind: string;
  title: string;
  description: string;
  url_canonical: string;
  ingest_status: string;
  partial_reason: string | null;
  creator_name: string;        // preferred name + variants (concatenated)
  folder_paths: string[];      // distinct folder paths for items pointing at this Instance
  bm25_rank: number;           // FTS5 rank score (lower = better, BM25 convention)
}

export interface FacetCounts {
  source: Record<string, number>;
  kind: Record<string, number>;
  folder: Array<{ path: string; count: number }>;   // top N folders only
  creator: Array<{ name: string; count: number }>;  // top N creators only
}

export interface SearchResult {
  query_raw: string;          // exactly what the caller passed
  query_executed: string;     // the FTS5 MATCH expression we ran (after sanitize + prefix)
  relaxed: boolean;           // true if we dropped tokens to get any results
  items: SearchHit[];
  count: number;              // total matching, may exceed items.length when limit binds
  facets: FacetCounts;
}

// FTS5 metacharacters that must be stripped from user input before query
// construction. Same set Kompl uses in searchPages. Without this, a query
// like `c++ unions` raises a syntax error from FTS5.
const FTS5_META = /['"*^():.,\-]/g;

// English stopwords — words that constrain the FTS AND-join without adding
// signal. "tools for agents" should match "tools" + "agents", not require
// "for" to appear literally. Standard discovery-layer behavior.
// Kept small intentionally — only words that almost never carry topic load.
const STOPWORDS = new Set([
  "a", "an", "and", "or", "the", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "are", "was", "were", "be", "been",
  "being", "do", "does", "did", "have", "has", "had", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your",
  "it", "its", "any", "what", "which", "who", "how",
]);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const TOP_N_FACET_VALUES = 12;

/**
 * Sanitize + prefix-match a free-text query for FTS5.
 *   "agent memory" → `agent* memory*`
 *   "tools for agents" → `tools* agents*` (stopword 'for' dropped)
 *   "c++ unions"   → `c unions*` then `unions*` (single-letter dropped)
 * Tokens of length 1 are dropped (prefix-matching a single letter tanks perf).
 * Stopwords are dropped (don't constrain the AND-join unnecessarily).
 */
function buildFtsQuery(rawQuery: string): string {
  return rawQuery
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(FTS5_META, "").trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map((t) => `${t}*`)
    .join(" ");
}

export function searchCatalog(
  db: DB,
  query: string,
  opts: SearchOptions = {}
): SearchResult {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const filters = opts.facet_filters ?? {};
  // Default to ok-only unless caller passes an explicit filter (including []
  // to mean "include all statuses").
  const statusFilter =
    filters.ingest_status === undefined ? ["ok"] : filters.ingest_status;

  const rawTrimmed = query.trim();
  const hasActiveFilters =
    (filters.source !== undefined && filters.source.length > 0) ||
    (filters.kind !== undefined && filters.kind.length > 0) ||
    (filters.folder_prefix !== undefined && filters.folder_prefix.length > 0) ||
    (filters.partial_reason !== undefined && filters.partial_reason.length > 0) ||
    // Status filter counts as user-driven narrowing only if it deviates from
    // the default (["ok"]) — i.e. caller explicitly broadened or narrowed it.
    (filters.ingest_status !== undefined);

  // Empty query is only valid when at least one filter narrows the result set.
  // Without filters we'd dump every Instance in the catalog.
  if (!rawTrimmed && !hasActiveFilters) {
    return emptyResult(query, "");
  }

  // No FTS query but filters present: filter-only browse mode (no BM25, sort
  // by recency via items.save_date). This is what surfaces dead-link cleanup
  // queries like `search "" --partial dead_link --status all`.
  let ftsQuery = buildFtsQuery(rawTrimmed);
  if (!ftsQuery) {
    if (hasActiveFilters) {
      return runFilterOnlyBrowse(db, filters, statusFilter, limit, query);
    }
    // Query was all single letters or meta-chars and no filters — nothing to search.
    return emptyResult(query, "");
  }

  let { hits, count } = runFtsSearch(db, ftsQuery, filters, statusFilter, limit);
  let relaxed = false;

  // Zero-result relaxation: drop one token at a time from the END (FTS5
  // queries are AND by default; dropping a token broadens the match).
  // Right-to-left because in English the most distinctive noun usually comes
  // last; relaxing the rightmost token first preserves the most signal.
  if (count === 0) {
    const tokens = ftsQuery.split(" ");
    while (tokens.length > 1 && count === 0) {
      tokens.pop();
      const relaxedQuery = tokens.join(" ");
      const r = runFtsSearch(db, relaxedQuery, filters, statusFilter, limit);
      if (r.count > 0) {
        hits = r.hits;
        count = r.count;
        ftsQuery = relaxedQuery;
        relaxed = true;
        break;
      }
    }
  }

  const facets = count > 0
    ? computeFacets(db, ftsQuery, filters, statusFilter)
    : emptyFacets();

  return {
    query_raw: query,
    query_executed: ftsQuery,
    relaxed,
    items: hits,
    count,
    facets,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Core SQL builder. Keeps the WHERE clause assembly in one place so both the
// items query and the facet-count queries stay in sync.
// ──────────────────────────────────────────────────────────────────────────
function buildWhere(
  ftsQuery: string,
  filters: SearchOptions["facet_filters"],
  statusFilter: string[]
): { sql: string; params: any[] } {
  const where: string[] = ["instances_fts MATCH ?"];
  const params: any[] = [ftsQuery];

  const f = filters ?? {};
  if (f.source && f.source.length > 0) {
    where.push(`source IN (${f.source.map(() => "?").join(",")})`);
    params.push(...f.source);
  }
  if (f.kind && f.kind.length > 0) {
    where.push(`kind IN (${f.kind.map(() => "?").join(",")})`);
    params.push(...f.kind);
  }
  if (statusFilter.length > 0) {
    where.push(`ingest_status IN (${statusFilter.map(() => "?").join(",")})`);
    params.push(...statusFilter);
  }
  if (f.partial_reason && f.partial_reason.length > 0) {
    where.push(`partial_reason IN (${f.partial_reason.map(() => "?").join(",")})`);
    params.push(...f.partial_reason);
  }
  // folder_prefix is applied as a LIKE on folder_paths (we splat folder
  // segments space-separated into the FTS field; for prefix matching we go
  // back to items via JOIN).
  // Handled separately in runFtsSearch for clarity.

  return { sql: where.join(" AND "), params };
}

function runFtsSearch(
  db: DB,
  ftsQuery: string,
  filters: SearchOptions["facet_filters"] | undefined,
  statusFilter: string[],
  limit: number
): { hits: SearchHit[]; count: number } {
  const { sql: whereSql, params } = buildWhere(ftsQuery, filters, statusFilter);
  const folderPrefix = filters?.folder_prefix;

  // Count total matching first (so caller knows full size even when limit binds).
  let countSql = `SELECT COUNT(*) AS c FROM instances_fts WHERE ${whereSql}`;
  let countParams = [...params];
  if (folderPrefix) {
    countSql = `
      SELECT COUNT(DISTINCT f.instance_id) AS c
      FROM instances_fts f
      JOIN items it ON it.instance_id = f.instance_id
      WHERE ${whereSql} AND it.bookmark_folder_path LIKE ?
    `;
    countParams = [...params, folderPrefix + "%"];
  }
  const count = (db.prepare(countSql).get(...countParams) as { c: number }).c;
  if (count === 0) return { hits: [], count: 0 };

  // Fetch ranked hits. ORDER BY rank is FTS5's BM25 (lower = better).
  let itemsSql = `
    SELECT f.instance_id, f.title, f.description, f.url_canonical,
           f.source, f.kind, f.ingest_status, f.partial_reason, f.creator_name,
           f.folder_paths, f.rank AS bm25_rank
    FROM instances_fts f
    WHERE ${whereSql}
    ORDER BY f.rank
    LIMIT ?
  `;
  let itemsParams: any[] = [...params, limit];
  if (folderPrefix) {
    itemsSql = `
      SELECT DISTINCT f.instance_id, f.title, f.description, f.url_canonical,
             f.source, f.kind, f.ingest_status, f.partial_reason, f.creator_name,
             f.folder_paths, f.rank AS bm25_rank
      FROM instances_fts f
      JOIN items it ON it.instance_id = f.instance_id
      WHERE ${whereSql} AND it.bookmark_folder_path LIKE ?
      ORDER BY f.rank
      LIMIT ?
    `;
    itemsParams = [...params, folderPrefix + "%", limit];
  }
  const rows = db.prepare(itemsSql).all(...itemsParams) as Array<{
    instance_id: string; title: string; description: string;
    url_canonical: string; source: string; kind: string;
    ingest_status: string; partial_reason: string; creator_name: string;
    folder_paths: string; bm25_rank: number;
  }>;

  // Re-attach individual folder paths from items for each hit (single roundtrip).
  const idList = rows.map((r) => r.instance_id);
  const folderMap = new Map<string, string[]>();
  if (idList.length > 0) {
    const placeholders = idList.map(() => "?").join(",");
    const folderRows = db.prepare(
      `SELECT DISTINCT instance_id, bookmark_folder_path
       FROM items
       WHERE instance_id IN (${placeholders}) AND bookmark_folder_path != ''`
    ).all(...idList) as Array<{ instance_id: string; bookmark_folder_path: string }>;
    for (const fr of folderRows) {
      const arr = folderMap.get(fr.instance_id) ?? [];
      arr.push(fr.bookmark_folder_path);
      folderMap.set(fr.instance_id, arr);
    }
  }

  const hits: SearchHit[] = rows.map((r) => ({
    instance_id: r.instance_id,
    source: r.source,
    kind: r.kind,
    title: r.title,
    description: r.description,
    url_canonical: r.url_canonical,
    ingest_status: r.ingest_status,
    partial_reason: r.partial_reason || null,
    creator_name: r.creator_name,
    folder_paths: folderMap.get(r.instance_id) ?? [],
    bm25_rank: r.bm25_rank,
  }));

  return { hits, count };
}

// ──────────────────────────────────────────────────────────────────────────
// Filter-only browse path. No FTS MATCH, no BM25; sort by save_date DESC so
// `search "" --partial dead_link --status all` surfaces recently-bookmarked
// dead links first. Reads from `instances` directly to dodge the UNINDEXED-
// column ambiguity that bit the FTS facet queries.
// ──────────────────────────────────────────────────────────────────────────
function runFilterOnlyBrowse(
  db: DB,
  filters: NonNullable<SearchOptions["facet_filters"]>,
  statusFilter: string[],
  limit: number,
  rawQuery: string
): SearchResult {
  const { sql: whereSql, params } = buildBrowseWhere(filters, statusFilter);
  const folderPrefix = filters.folder_prefix;

  // Count
  let countSql = `
    SELECT COUNT(DISTINCT i.id) AS c
    FROM instances i
    ${folderPrefix ? "JOIN items it ON it.instance_id = i.id" : ""}
    WHERE ${whereSql}
    ${folderPrefix ? "AND it.bookmark_folder_path LIKE ?" : ""}
  `;
  const countParams = folderPrefix ? [...params, folderPrefix + "%"] : [...params];
  const count = (db.prepare(countSql).get(...countParams) as { c: number }).c;

  if (count === 0) {
    return {
      query_raw: rawQuery,
      query_executed: "",
      relaxed: false,
      items: [],
      count: 0,
      facets: emptyFacets(),
    };
  }

  // Hits — pull from instances + LEFT JOIN authorities for creator_name.
  // Sort by the most recent save_date across items pointing at each instance.
  const hitsSql = `
    SELECT
      i.id AS instance_id,
      i.source, i.kind, i.url_canonical,
      COALESCE(i.title, '') AS title,
      COALESCE(i.description, '') AS description,
      i.ingest_status, i.partial_reason,
      COALESCE(a.preferred, '') AS creator_name,
      (SELECT MAX(it2.save_date) FROM items it2 WHERE it2.instance_id = i.id) AS latest_save
    FROM instances i
    LEFT JOIN authorities a ON a.id = i.creator_authority_id
    ${folderPrefix ? "JOIN items it ON it.instance_id = i.id" : ""}
    WHERE ${whereSql}
    ${folderPrefix ? "AND it.bookmark_folder_path LIKE ?" : ""}
    GROUP BY i.id
    ORDER BY latest_save DESC
    LIMIT ?
  `;
  const hitsParams = folderPrefix
    ? [...params, folderPrefix + "%", limit]
    : [...params, limit];
  const rows = db.prepare(hitsSql).all(...hitsParams) as Array<{
    instance_id: string; source: string; kind: string; url_canonical: string;
    title: string; description: string; ingest_status: string;
    partial_reason: string | null; creator_name: string; latest_save: number;
  }>;

  // Re-attach folder paths for each hit (same as runFtsSearch).
  const idList = rows.map((r) => r.instance_id);
  const folderMap = new Map<string, string[]>();
  if (idList.length > 0) {
    const placeholders = idList.map(() => "?").join(",");
    const folderRows = db.prepare(
      `SELECT DISTINCT instance_id, bookmark_folder_path
       FROM items
       WHERE instance_id IN (${placeholders}) AND bookmark_folder_path != ''`
    ).all(...idList) as Array<{ instance_id: string; bookmark_folder_path: string }>;
    for (const fr of folderRows) {
      const arr = folderMap.get(fr.instance_id) ?? [];
      arr.push(fr.bookmark_folder_path);
      folderMap.set(fr.instance_id, arr);
    }
  }

  const hits: SearchHit[] = rows.map((r) => ({
    instance_id: r.instance_id,
    source: r.source,
    kind: r.kind,
    title: r.title,
    description: r.description,
    url_canonical: r.url_canonical,
    ingest_status: r.ingest_status,
    partial_reason: r.partial_reason || null,
    creator_name: r.creator_name,
    folder_paths: folderMap.get(r.instance_id) ?? [],
    bm25_rank: 0, // no rank in browse mode — caller sorts by save_date
  }));

  return {
    query_raw: rawQuery,
    query_executed: "",
    relaxed: false,
    items: hits,
    count,
    facets: computeBrowseFacets(db, filters, statusFilter),
  };
}

// WHERE-clause builder for the filter-only path. Mirrors buildWhere but
// targets `instances` columns directly (no MATCH, no FTS table reference).
function buildBrowseWhere(
  filters: NonNullable<SearchOptions["facet_filters"]>,
  statusFilter: string[]
): { sql: string; params: any[] } {
  const where: string[] = ["1=1"];
  const params: any[] = [];
  if (filters.source && filters.source.length > 0) {
    where.push(`i.source IN (${filters.source.map(() => "?").join(",")})`);
    params.push(...filters.source);
  }
  if (filters.kind && filters.kind.length > 0) {
    where.push(`i.kind IN (${filters.kind.map(() => "?").join(",")})`);
    params.push(...filters.kind);
  }
  if (statusFilter.length > 0) {
    where.push(`i.ingest_status IN (${statusFilter.map(() => "?").join(",")})`);
    params.push(...statusFilter);
  }
  if (filters.partial_reason && filters.partial_reason.length > 0) {
    where.push(`i.partial_reason IN (${filters.partial_reason.map(() => "?").join(",")})`);
    params.push(...filters.partial_reason);
  }
  return { sql: where.join(" AND "), params };
}

// Facet counts for browse mode — same omit-this-facet trick as computeFacets,
// but against the instances table directly.
function computeBrowseFacets(
  db: DB,
  filters: NonNullable<SearchOptions["facet_filters"]>,
  statusFilter: string[]
): FacetCounts {
  const sourceFacet = browseCountByColumn(db, filters, statusFilter, "source");
  const kindFacet = browseCountByColumn(db, filters, statusFilter, "kind");

  // Folder facet
  const folderFilters = omitFilter(filters, "folder_prefix") ?? {};
  const folderWhere = buildBrowseWhere(folderFilters, statusFilter);
  const folderRows = db.prepare(`
    SELECT it.bookmark_folder_path AS path, COUNT(DISTINCT i.id) AS c
    FROM instances i
    JOIN items it ON it.instance_id = i.id
    WHERE ${folderWhere.sql} AND it.bookmark_folder_path != ''
    GROUP BY it.bookmark_folder_path
    ORDER BY c DESC
    LIMIT ?
  `).all(...folderWhere.params, TOP_N_FACET_VALUES) as Array<{ path: string; c: number }>;

  // Creator facet
  const creatorWhere = buildBrowseWhere(filters, statusFilter);
  const creatorRows = db.prepare(`
    SELECT a.preferred AS name, COUNT(DISTINCT i.id) AS c
    FROM instances i
    JOIN authorities a ON a.id = i.creator_authority_id
    WHERE ${creatorWhere.sql} AND i.creator_authority_id IS NOT NULL
    GROUP BY a.preferred
    ORDER BY c DESC
    LIMIT ?
  `).all(...creatorWhere.params, TOP_N_FACET_VALUES) as Array<{ name: string; c: number }>;

  return {
    source: sourceFacet,
    kind: kindFacet,
    folder: folderRows.map((r) => ({ path: r.path, count: r.c })),
    creator: creatorRows.map((r) => ({ name: r.name, count: r.c })),
  };
}

function browseCountByColumn(
  db: DB,
  filters: NonNullable<SearchOptions["facet_filters"]>,
  statusFilter: string[],
  column: "source" | "kind"
): Record<string, number> {
  // Omit this facet's own filter so counts show all values matching everything else.
  const omitted = omitFilter(filters, column) ?? {};
  const { sql, params } = buildBrowseWhere(omitted, statusFilter);
  const rows = db.prepare(`
    SELECT i.${column} AS k, COUNT(*) AS c
    FROM instances i
    WHERE ${sql}
    GROUP BY i.${column}
    ORDER BY c DESC
  `).all(...params) as Array<{ k: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.k] = r.c;
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Facet count computation. Runs over the SAME filter set as the main query
// EXCEPT for the facet being counted (so source counts show ALL sources
// matching the query, not just the source the caller already filtered to).
// This is the canonical "faceted refinement" UX from discovery layers.
// ──────────────────────────────────────────────────────────────────────────
function computeFacets(
  db: DB,
  ftsQuery: string,
  filters: SearchOptions["facet_filters"] | undefined,
  statusFilter: string[]
): FacetCounts {
  // Source facet — ignore caller's source filter (show all sources matching).
  const sourceFacet = countByColumn(db, ftsQuery, filters, statusFilter, "source", "source");
  // Kind facet — ignore caller's kind filter.
  const kindFacet = countByColumn(db, ftsQuery, filters, statusFilter, "kind", "kind");

  // Folder facet — needs JOIN to items. Apply caller's other filters but not folder_prefix.
  // items.ingest_status would collide with instances_fts.ingest_status — qualify all FTS columns.
  const folderWhere = buildWhere(ftsQuery, omitFilter(filters, "folder_prefix"), statusFilter);
  const folderQualifiedWhere = folderWhere.sql
    .replace(/\bsource\b/g, "f.source")
    .replace(/\bkind\b/g, "f.kind")
    .replace(/\bingest_status\b/g, "f.ingest_status")
    .replace(/\bpartial_reason\b/g, "f.partial_reason");
  const folderRows = db.prepare(`
    SELECT it.bookmark_folder_path AS path, COUNT(DISTINCT f.instance_id) AS c
    FROM instances_fts f
    JOIN items it ON it.instance_id = f.instance_id
    WHERE ${folderQualifiedWhere}
      AND it.bookmark_folder_path != ''
    GROUP BY it.bookmark_folder_path
    ORDER BY c DESC
    LIMIT ?
  `).all(...folderWhere.params, TOP_N_FACET_VALUES) as Array<{ path: string; c: number }>;

  // Creator facet — extract from instances.creator_authority_id → authorities.preferred.
  // Note: instances_fts and instances both have 'source' column, so qualify explicitly.
  const creatorWhere = buildWhere(ftsQuery, filters, statusFilter);
  // Rewrite the WHERE clause to qualify ambiguous columns from the joined instances table.
  const qualifiedWhere = creatorWhere.sql
    .replace(/\bsource\b/g, "f.source")
    .replace(/\bkind\b/g, "f.kind")
    .replace(/\bingest_status\b/g, "f.ingest_status")
    .replace(/\bpartial_reason\b/g, "f.partial_reason");
  const creatorRows = db.prepare(`
    SELECT a.preferred AS name, COUNT(DISTINCT f.instance_id) AS c
    FROM instances_fts f
    JOIN instances i ON i.id = f.instance_id
    JOIN authorities a ON a.id = i.creator_authority_id
    WHERE ${qualifiedWhere}
      AND i.creator_authority_id IS NOT NULL
    GROUP BY a.preferred
    ORDER BY c DESC
    LIMIT ?
  `).all(...creatorWhere.params, TOP_N_FACET_VALUES) as Array<{ name: string; c: number }>;

  return {
    source: sourceFacet,
    kind: kindFacet,
    folder: folderRows.map((r) => ({ path: r.path, count: r.c })),
    creator: creatorRows.map((r) => ({ name: r.name, count: r.c })),
  };
}

function countByColumn(
  db: DB,
  ftsQuery: string,
  filters: SearchOptions["facet_filters"] | undefined,
  statusFilter: string[],
  column: string,
  facetName: keyof NonNullable<SearchOptions["facet_filters"]>
): Record<string, number> {
  const { sql, params } = buildWhere(
    ftsQuery, omitFilter(filters, facetName), statusFilter
  );
  const rows = db.prepare(
    `SELECT ${column} AS k, COUNT(*) AS c FROM instances_fts WHERE ${sql} GROUP BY ${column} ORDER BY c DESC`
  ).all(...params) as Array<{ k: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.k] = r.c;
  return out;
}

function omitFilter(
  filters: SearchOptions["facet_filters"] | undefined,
  key: keyof NonNullable<SearchOptions["facet_filters"]>
): SearchOptions["facet_filters"] {
  if (!filters) return undefined;
  const { [key]: _omit, ...rest } = filters;
  return rest;
}

function emptyFacets(): FacetCounts {
  return { source: {}, kind: {}, folder: [], creator: [] };
}

function emptyResult(rawQuery: string, executedQuery: string): SearchResult {
  return {
    query_raw: rawQuery,
    query_executed: executedQuery,
    relaxed: false,
    items: [],
    count: 0,
    facets: emptyFacets(),
  };
}
