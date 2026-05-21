// Catalog search — discovery-layer primitive.
//
// Pattern (post-OPAC 2.0 standard): one BM25-ranked FTS5 query across all
// access points (title, description, folder paths, creator name, URL, GitHub topics),
// facet filters applied in the outer query so BM25 order is preserved.
// Zero-result fallback: drop rightmost AND token, then OR across remaining tokens.

import type { DB } from "./db.js";

export interface SearchOptions {
  limit?: number;
  facet_filters?: {
    source?: string[];
    kind?: string[];
    folder_prefix?: string;
    creator_prefix?: string[];
    topic_prefix?: string[];
    ingest_status?: string[];
    partial_reason?: string[];
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
  creator_name: string;
  folder_paths: string[];
  topics: string[];
  bm25_rank: number;
}

export interface FacetCounts {
  source: Record<string, number>;
  kind: Record<string, number>;
  folder: Array<{ path: string; count: number }>;
  creator: Array<{ name: string; count: number }>;
  topic: Array<{ name: string; count: number }>;
}

export type RelaxedMode = "none" | "drop_token" | "or";

export interface SearchResult {
  query_raw: string;
  query_executed: string;
  relaxed: boolean;
  relaxed_mode: RelaxedMode;
  items: SearchHit[];
  count: number;
  facets: FacetCounts;
}

const FTS5_META = /['"*^():.,\-]/g;

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

function tokenizeQuery(rawQuery: string): string[] {
  return rawQuery
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(FTS5_META, "").trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function buildFtsQuery(rawQuery: string): string {
  return tokenizeQuery(rawQuery).map((t) => `${t}*`).join(" ");
}

function buildFtsOrQuery(rawQuery: string): string {
  const tokens = tokenizeQuery(rawQuery);
  if (tokens.length < 2) return "";
  return tokens.map((t) => `${t}*`).join(" OR ");
}

function parseTopics(ftsTopics: string | null | undefined): string[] {
  if (!ftsTopics?.trim()) return [];
  return ftsTopics.trim().split(/\s+/).filter(Boolean);
}

function parseTopicsFromPayload(sourcePayloadJson: string | null): string[] {
  if (!sourcePayloadJson) return [];
  try {
    const payload = JSON.parse(sourcePayloadJson) as { topics?: unknown };
    if (!Array.isArray(payload.topics)) return [];
    return payload.topics.filter((t): t is string => typeof t === "string" && t.length > 0);
  } catch {
    return [];
  }
}

function qualifyFtsWhere(sql: string): string {
  // Keep `instances_fts MATCH` — FTS5 requires the virtual table name for MATCH,
  // even when the FROM clause aliases it as f.
  return sql
    .replace(/\bsource\b/g, "f.source")
    .replace(/\bkind\b/g, "f.kind")
    .replace(/\bingest_status\b/g, "f.ingest_status")
    .replace(/\bpartial_reason\b/g, "f.partial_reason");
}

function buildFilterJoins(
  filters: SearchOptions["facet_filters"] | undefined,
  aliasInstance = "i"
): { joins: string; extraWhere: string[]; extraParams: unknown[]; needsDistinct: boolean } {
  const joins: string[] = [];
  const extraWhere: string[] = [];
  const extraParams: unknown[] = [];
  const f = filters ?? {};

  if (f.folder_prefix) {
    joins.push("JOIN items it ON it.instance_id = f.instance_id");
    extraWhere.push("it.bookmark_folder_path LIKE ?");
    extraParams.push(f.folder_prefix + "%");
  }

  const needsInstance =
    (f.creator_prefix?.length ?? 0) > 0 || (f.topic_prefix?.length ?? 0) > 0;
  if (needsInstance) {
    joins.push(`JOIN instances ${aliasInstance} ON ${aliasInstance}.id = f.instance_id`);
  }

  if (f.creator_prefix && f.creator_prefix.length > 0) {
    joins.push(`JOIN authorities a ON a.id = ${aliasInstance}.creator_authority_id`);
    const clauses = f.creator_prefix.map(() => "lower(a.preferred) LIKE lower(?) || '%'");
    extraWhere.push(`(${clauses.join(" OR ")})`);
    extraParams.push(...f.creator_prefix);
  }

  if (f.topic_prefix && f.topic_prefix.length > 0) {
    const clauses = f.topic_prefix.map(
      () =>
        `EXISTS (SELECT 1 FROM json_each(json_extract(${aliasInstance}.source_payload_json, '$.topics')) je WHERE lower(je.value) LIKE lower(?) || '%')`
    );
    extraWhere.push(`(${clauses.join(" OR ")})`);
    extraParams.push(...f.topic_prefix);
  }

  return {
    joins: joins.join("\n      "),
    extraWhere,
    extraParams,
    needsDistinct: joins.length > 0,
  };
}

function combineWhere(base: string, extra: string[]): string {
  if (extra.length === 0) return base;
  return `${base} AND ${extra.join(" AND ")}`;
}

export function searchCatalog(
  db: DB,
  query: string,
  opts: SearchOptions = {}
): SearchResult {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const filters = opts.facet_filters ?? {};
  const statusFilter =
    filters.ingest_status === undefined ? ["ok"] : filters.ingest_status;

  const rawTrimmed = query.trim();
  const hasActiveFilters =
    (filters.source !== undefined && filters.source.length > 0) ||
    (filters.kind !== undefined && filters.kind.length > 0) ||
    (filters.folder_prefix !== undefined && filters.folder_prefix.length > 0) ||
    (filters.creator_prefix !== undefined && filters.creator_prefix.length > 0) ||
    (filters.topic_prefix !== undefined && filters.topic_prefix.length > 0) ||
    (filters.partial_reason !== undefined && filters.partial_reason.length > 0) ||
    (filters.ingest_status !== undefined);

  if (!rawTrimmed && !hasActiveFilters) {
    return emptyResult(query, "");
  }

  let ftsQuery = buildFtsQuery(rawTrimmed);
  if (!ftsQuery) {
    if (hasActiveFilters) {
      return runFilterOnlyBrowse(db, filters, statusFilter, limit, query);
    }
    return emptyResult(query, "");
  }

  let { hits, count } = runFtsSearch(db, ftsQuery, filters, statusFilter, limit);
  let relaxed = false;
  let relaxed_mode: RelaxedMode = "none";

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
        relaxed_mode = "drop_token";
        break;
      }
    }
  }

  if (count === 0 && tokenizeQuery(rawTrimmed).length >= 2) {
    const orQuery = buildFtsOrQuery(rawTrimmed);
    if (orQuery) {
      const r = runFtsSearch(db, orQuery, filters, statusFilter, limit);
      if (r.count > 0) {
        hits = r.hits;
        count = r.count;
        ftsQuery = orQuery;
        relaxed = true;
        relaxed_mode = "or";
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
    relaxed_mode,
    items: hits,
    count,
    facets,
  };
}

function buildWhere(
  ftsQuery: string,
  filters: SearchOptions["facet_filters"],
  statusFilter: string[]
): { sql: string; params: unknown[] } {
  const where: string[] = ["instances_fts MATCH ?"];
  const params: unknown[] = [ftsQuery];

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
  const qualifiedWhere = qualifyFtsWhere(whereSql);
  const { joins, extraWhere, extraParams, needsDistinct } = buildFilterJoins(filters);
  const fullWhere = combineWhere(qualifiedWhere, extraWhere);
  const allParams = [...params, ...extraParams];

  const countExpr = needsDistinct ? "COUNT(DISTINCT f.instance_id)" : "COUNT(*)";
  const count = (
    db.prepare(`
      SELECT ${countExpr} AS c
      FROM instances_fts f
      ${joins}
      WHERE ${fullWhere}
    `).get(...allParams) as { c: number }
  ).c;
  if (count === 0) return { hits: [], count: 0 };

  const distinct = needsDistinct ? "DISTINCT " : "";
  const rows = db.prepare(`
    SELECT ${distinct}f.instance_id, f.title, f.description, f.url_canonical,
           f.source, f.kind, f.ingest_status, f.partial_reason, f.creator_name,
           f.topics, f.rank AS bm25_rank
    FROM instances_fts f
    ${joins}
    WHERE ${fullWhere}
    ORDER BY f.rank
    LIMIT ?
  `).all(...allParams, limit) as Array<{
    instance_id: string; title: string; description: string;
    url_canonical: string; source: string; kind: string;
    ingest_status: string; partial_reason: string; creator_name: string;
    topics: string; bm25_rank: number;
  }>;

  const idList = rows.map((r) => r.instance_id);
  const folderMap = loadFolderMap(db, idList);

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
    topics: parseTopics(r.topics),
    bm25_rank: r.bm25_rank,
  }));

  return { hits, count };
}

function loadFolderMap(db: DB, idList: string[]): Map<string, string[]> {
  const folderMap = new Map<string, string[]>();
  if (idList.length === 0) return folderMap;
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
  return folderMap;
}

function runFilterOnlyBrowse(
  db: DB,
  filters: NonNullable<SearchOptions["facet_filters"]>,
  statusFilter: string[],
  limit: number,
  rawQuery: string
): SearchResult {
  const { sql: whereSql, params } = buildBrowseWhere(filters, statusFilter);
  const folderPrefix = filters.folder_prefix;
  const creatorPrefixes = filters.creator_prefix ?? [];
  const topicPrefixes = filters.topic_prefix ?? [];

  let extraJoins = "";
  const extraWhere: string[] = [];
  const extraParams: unknown[] = [];

  if (creatorPrefixes.length > 0) {
    extraJoins += "\n    JOIN authorities a ON a.id = i.creator_authority_id";
    const clauses = creatorPrefixes.map(() => "lower(a.preferred) LIKE lower(?) || '%'");
    extraWhere.push(`(${clauses.join(" OR ")})`);
    extraParams.push(...creatorPrefixes);
  }
  if (topicPrefixes.length > 0) {
    const clauses = topicPrefixes.map(
      () =>
        "EXISTS (SELECT 1 FROM json_each(json_extract(i.source_payload_json, '$.topics')) je WHERE lower(je.value) LIKE lower(?) || '%')"
    );
    extraWhere.push(`(${clauses.join(" OR ")})`);
    extraParams.push(...topicPrefixes);
  }

  const fullWhere = extraWhere.length > 0
    ? `${whereSql} AND ${extraWhere.join(" AND ")}`
    : whereSql;
  const allParams = [...params, ...extraParams];

  const countSql = `
    SELECT COUNT(DISTINCT i.id) AS c
    FROM instances i
    ${folderPrefix ? "JOIN items it ON it.instance_id = i.id" : ""}
    ${extraJoins}
    WHERE ${fullWhere}
    ${folderPrefix ? "AND it.bookmark_folder_path LIKE ?" : ""}
  `;
  const countParams = folderPrefix ? [...allParams, folderPrefix + "%"] : allParams;
  const count = (db.prepare(countSql).get(...countParams) as { c: number }).c;

  if (count === 0) {
    return {
      query_raw: rawQuery,
      query_executed: "",
      relaxed: false,
      relaxed_mode: "none",
      items: [],
      count: 0,
      facets: emptyFacets(),
    };
  }

  const hitsSql = `
    SELECT
      i.id AS instance_id,
      i.source, i.kind, i.url_canonical,
      COALESCE(i.title, '') AS title,
      COALESCE(i.description, '') AS description,
      i.ingest_status, i.partial_reason,
      i.source_payload_json,
      COALESCE(a.preferred, '') AS creator_name,
      (SELECT MAX(it2.save_date) FROM items it2 WHERE it2.instance_id = i.id) AS latest_save
    FROM instances i
    LEFT JOIN authorities a ON a.id = i.creator_authority_id
    ${folderPrefix ? "JOIN items it ON it.instance_id = i.id" : ""}
    ${extraJoins}
    WHERE ${fullWhere}
    ${folderPrefix ? "AND it.bookmark_folder_path LIKE ?" : ""}
    GROUP BY i.id
    ORDER BY latest_save DESC
    LIMIT ?
  `;
  const hitsParams = folderPrefix
    ? [...allParams, folderPrefix + "%", limit]
    : [...allParams, limit];
  const rows = db.prepare(hitsSql).all(...hitsParams) as Array<{
    instance_id: string; source: string; kind: string; url_canonical: string;
    title: string; description: string; ingest_status: string;
    partial_reason: string | null; creator_name: string;
    source_payload_json: string | null; latest_save: number;
  }>;

  const idList = rows.map((r) => r.instance_id);
  const folderMap = loadFolderMap(db, idList);

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
    topics: parseTopicsFromPayload(r.source_payload_json),
    bm25_rank: 0,
  }));

  return {
    query_raw: rawQuery,
    query_executed: "",
    relaxed: false,
    relaxed_mode: "none",
    items: hits,
    count,
    facets: computeBrowseFacets(db, filters, statusFilter),
  };
}

function buildBrowseWhere(
  filters: NonNullable<SearchOptions["facet_filters"]>,
  statusFilter: string[]
): { sql: string; params: unknown[] } {
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
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

function computeBrowseFacets(
  db: DB,
  filters: NonNullable<SearchOptions["facet_filters"]>,
  statusFilter: string[]
): FacetCounts {
  const sourceFacet = browseCountByColumn(db, filters, statusFilter, "source");
  const kindFacet = browseCountByColumn(db, filters, statusFilter, "kind");

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

  const creatorFilters = omitFilter(filters, "creator_prefix") ?? {};
  const creatorWhere = buildBrowseWhere(creatorFilters, statusFilter);
  const creatorRows = db.prepare(`
    SELECT a.preferred AS name, COUNT(DISTINCT i.id) AS c
    FROM instances i
    JOIN authorities a ON a.id = i.creator_authority_id
    WHERE ${creatorWhere.sql} AND i.creator_authority_id IS NOT NULL
    GROUP BY a.preferred
    ORDER BY c DESC
    LIMIT ?
  `).all(...creatorWhere.params, TOP_N_FACET_VALUES) as Array<{ name: string; c: number }>;

  const topicFilters = omitFilter(filters, "topic_prefix") ?? {};
  const topicWhere = buildBrowseWhere(topicFilters, statusFilter);
  const topicRows = db.prepare(`
    SELECT j.value AS name, COUNT(DISTINCT i.id) AS c
    FROM instances i
    JOIN json_each(json_extract(i.source_payload_json, '$.topics')) j
    WHERE ${topicWhere.sql}
    GROUP BY j.value
    ORDER BY c DESC
    LIMIT ?
  `).all(...topicWhere.params, TOP_N_FACET_VALUES) as Array<{ name: string; c: number }>;

  return {
    source: sourceFacet,
    kind: kindFacet,
    folder: folderRows.map((r) => ({ path: r.path, count: r.c })),
    creator: creatorRows.map((r) => ({ name: r.name, count: r.c })),
    topic: topicRows.map((r) => ({ name: r.name, count: r.c })),
  };
}

function browseCountByColumn(
  db: DB,
  filters: NonNullable<SearchOptions["facet_filters"]>,
  statusFilter: string[],
  column: "source" | "kind"
): Record<string, number> {
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

function computeFacets(
  db: DB,
  ftsQuery: string,
  filters: SearchOptions["facet_filters"] | undefined,
  statusFilter: string[]
): FacetCounts {
  const sourceFacet = countByColumn(db, ftsQuery, filters, statusFilter, "source", "source");
  const kindFacet = countByColumn(db, ftsQuery, filters, statusFilter, "kind", "kind");

  const folderWhere = buildWhere(ftsQuery, omitFilter(filters, "folder_prefix"), statusFilter);
  const folderQualified = qualifyFtsWhere(folderWhere.sql);
  const folderJoins = buildFilterJoins(omitFilter(filters, "folder_prefix"));
  const folderFullWhere = combineWhere(folderQualified, folderJoins.extraWhere);
  const folderParams = [...folderWhere.params, ...folderJoins.extraParams];
  const folderRows = db.prepare(`
    SELECT it.bookmark_folder_path AS path, COUNT(DISTINCT f.instance_id) AS c
    FROM instances_fts f
    JOIN items it ON it.instance_id = f.instance_id
    ${folderJoins.joins}
    WHERE ${folderFullWhere} AND it.bookmark_folder_path != ''
    GROUP BY it.bookmark_folder_path
    ORDER BY c DESC
    LIMIT ?
  `).all(...folderParams, TOP_N_FACET_VALUES) as Array<{ path: string; c: number }>;

  const creatorFilters = omitFilter(filters, "creator_prefix");
  const creatorWhere = buildWhere(ftsQuery, creatorFilters, statusFilter);
  const creatorQualified = qualifyFtsWhere(creatorWhere.sql);
  const creatorFj = buildFilterJoins(creatorFilters);
  let creatorJoinSql = creatorFj.joins;
  if (!creatorJoinSql.includes("JOIN instances i")) {
    creatorJoinSql = creatorJoinSql
      ? `JOIN instances i ON i.id = f.instance_id\n      ${creatorJoinSql}`
      : "JOIN instances i ON i.id = f.instance_id\n      JOIN authorities a ON a.id = i.creator_authority_id";
  } else if (!creatorJoinSql.includes("JOIN authorities a")) {
    creatorJoinSql += "\n      JOIN authorities a ON a.id = i.creator_authority_id";
  }
  const creatorFullWhere = combineWhere(creatorQualified, [
    ...creatorFj.extraWhere,
    "i.creator_authority_id IS NOT NULL",
  ]);
  const creatorParams = [...creatorWhere.params, ...creatorFj.extraParams];
  const creatorRows = db.prepare(`
    SELECT a.preferred AS name, COUNT(DISTINCT f.instance_id) AS c
    FROM instances_fts f
    ${creatorJoinSql}
    WHERE ${creatorFullWhere}
    GROUP BY a.preferred
    ORDER BY c DESC
    LIMIT ?
  `).all(...creatorParams, TOP_N_FACET_VALUES) as Array<{ name: string; c: number }>;

  const topicFilters = omitFilter(filters, "topic_prefix");
  const topicWhere = buildWhere(ftsQuery, topicFilters, statusFilter);
  const topicQualified = qualifyFtsWhere(topicWhere.sql);
  const topicFj = buildFilterJoins(topicFilters);
  let topicJoinSql = topicFj.joins;
  if (!topicJoinSql.includes("JOIN instances i")) {
    topicJoinSql = topicJoinSql
      ? `JOIN instances i ON i.id = f.instance_id\n      ${topicJoinSql}`
      : "JOIN instances i ON i.id = f.instance_id";
  }
  const topicFullWhere = combineWhere(topicQualified, topicFj.extraWhere);
  const topicParams = [...topicWhere.params, ...topicFj.extraParams];
  const topicRows = db.prepare(`
    SELECT j.value AS name, COUNT(DISTINCT f.instance_id) AS c
    FROM instances_fts f
    ${topicJoinSql}
    JOIN json_each(json_extract(i.source_payload_json, '$.topics')) j
    WHERE ${topicFullWhere}
    GROUP BY j.value
    ORDER BY c DESC
    LIMIT ?
  `).all(...topicParams, TOP_N_FACET_VALUES) as Array<{ name: string; c: number }>;

  return {
    source: sourceFacet,
    kind: kindFacet,
    folder: folderRows.map((r) => ({ path: r.path, count: r.c })),
    creator: creatorRows.map((r) => ({ name: r.name, count: r.c })),
    topic: topicRows.map((r) => ({ name: r.name, count: r.c })),
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
  const { sql, params } = buildWhere(ftsQuery, omitFilter(filters, facetName), statusFilter);
  const qualified = qualifyFtsWhere(sql);
  const { joins, extraWhere, extraParams, needsDistinct } = buildFilterJoins(
    omitFilter(filters, facetName)
  );
  const fullWhere = combineWhere(qualified, extraWhere);
  const allParams = [...params, ...extraParams];
  const countExpr = needsDistinct ? "COUNT(DISTINCT f.instance_id)" : "COUNT(*)";

  const rows = db.prepare(`
    SELECT f.${column} AS k, ${countExpr} AS c
    FROM instances_fts f
    ${joins}
    WHERE ${fullWhere}
    GROUP BY f.${column}
    ORDER BY c DESC
  `).all(...allParams) as Array<{ k: string; c: number }>;
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
  return { source: {}, kind: {}, folder: [], creator: [], topic: [] };
}

function emptyResult(rawQuery: string, executedQuery: string): SearchResult {
  return {
    query_raw: rawQuery,
    query_executed: executedQuery,
    relaxed: false,
    relaxed_mode: "none",
    items: [],
    count: 0,
    facets: emptyFacets(),
  };
}
