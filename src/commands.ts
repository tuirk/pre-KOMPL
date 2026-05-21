// CLI command handlers.
import { ingestFolder } from "./orchestrator.js";
import { openDb, rebuildInstancesFts } from "./db.js";
import { loadConfig } from "./config.js";
import { reclassifyAll } from "./reclassify.js";
import { searchCatalog, type SearchResult, type SearchOptions } from "./search.js";
import type { ProgressEvent } from "./context.js";

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}

function printProgress(e: ProgressEvent): void {
  switch (e.kind) {
    case "file_scan": {
      const mark = e.type === "binary" || e.type === "empty" || e.type === "unrecognized" ? "✗" : "✓";
      const detail = e.entries !== undefined && e.entries > 0
        ? `${e.type} (${e.entries} entries)`
        : `${e.type}${e.reason ? ` — ${e.reason}` : ""}`;
      console.log(`  ${mark} ${e.path.split("/").pop()} → ${detail}`);
      break;
    }
    case "pipeline_start":
      console.log(`\n[${e.source}] ${e.total} URLs...`);
      break;
    case "pipeline_progress":
      process.stdout.write(`\r  ${e.done}/${e.total}`);
      break;
    case "pipeline_done":
      process.stdout.write(`\r`);
      console.log(`  → ${e.created} new, ${e.deduped} dedup hits`);
      break;
    case "ingest_done": {
      const s = e.summary;
      console.log(`\nDone in ${fmtMs(s.elapsed_ms)}.\n`);
      console.log(`Summary`);
      console.log(`─────────────────────────────────────────────`);
      console.log(`  Items created:    ${s.items_created}`);
      console.log(`  Instances:        ${s.instances_created}`);
      console.log(`  Authorities:      ${s.authorities_created_or_referenced}`);
      console.log(``);
      console.log(`  Status:`);
      console.log(`    ok:             ${s.by_status.ok}`);
      console.log(`    partial:        ${s.by_status.partial}`);
      console.log(`    error:          ${s.by_status.error}`);
      console.log(``);
      console.log(`  Files: ${s.files_processed} processed, ${s.files_skipped} skipped`);
      if (Object.keys(s.quota).length > 0) {
        console.log(``);
        console.log(`  Quota used:`);
        if (s.quota.youtube_units) console.log(`    YouTube units:    ${s.quota.youtube_units}/10000 daily`);
        if (s.quota.github_requests) console.log(`    GitHub requests:  ${s.quota.github_requests}/5000 hourly`);
        if (s.quota.firecrawl_credits) {
          const used = s.quota.firecrawl_credits;
          console.log(`    Firecrawl credits: ${used} this run`);
        }
      }
      if (s.by_status.error > 0) {
        console.log(`\n  → Run \`pre-kompl errors\` to see what failed.`);
      }
      if (s.by_status.partial > 0) {
        console.log(`  → Run \`pre-kompl partials\` to see what ingested but is incomplete.`);
      }
      break;
    }
  }
}

export async function cmdIngest(folder: string): Promise<void> {
  console.log(`\nScanning folder: ${folder}\n`);
  try {
    await ingestFolder(folder, printProgress);
  } catch (e: any) {
    console.error(`\nIngest failed: ${e.message}`);
    process.exit(1);
  }
}

export function cmdStatus(): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);

  const items = (db.prepare("SELECT COUNT(*) as c FROM items").get() as any).c;
  const instances = (db.prepare("SELECT COUNT(*) as c FROM instances").get() as any).c;
  const auths = (db.prepare("SELECT COUNT(*) as c FROM authorities").get() as any).c;
  const errs = (db.prepare("SELECT COUNT(*) as c FROM ingestion_errors WHERE resolved = 0").get() as any).c;

  const bySource = db.prepare(`
    SELECT source, COUNT(*) as c FROM instances GROUP BY source ORDER BY c DESC
  `).all() as Array<{ source: string; c: number }>;

  const byKind = db.prepare(`
    SELECT kind, COUNT(*) as c FROM instances GROUP BY kind ORDER BY c DESC
  `).all() as Array<{ kind: string; c: number }>;

  const byStatus = db.prepare(`
    SELECT ingest_status, COUNT(*) as c FROM instances GROUP BY ingest_status
  `).all() as Array<{ ingest_status: string; c: number }>;

  console.log(`\nDatabase: ${config.dbPath}\n`);
  console.log(`  Items:        ${items}`);
  console.log(`  Instances:    ${instances}`);
  console.log(`  Authorities:  ${auths}`);
  console.log(`  Unresolved errors: ${errs}`);
  console.log(``);
  console.log(`By source:`);
  for (const r of bySource) console.log(`  ${r.source.padEnd(10)} ${r.c}`);
  console.log(``);
  console.log(`By kind:`);
  for (const r of byKind) console.log(`  ${r.kind.padEnd(24)} ${r.c}`);
  console.log(``);
  console.log(`By ingest status:`);
  for (const r of byStatus) console.log(`  ${r.ingest_status.padEnd(10)} ${r.c}`);
  db.close();
}

export function cmdErrors(limit = 20): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);

  const total = (db.prepare("SELECT COUNT(*) as c FROM ingestion_errors WHERE resolved = 0").get() as any).c;
  if (total === 0) {
    console.log(`\nNo errors. Catalog is clean.`);
    db.close();
    return;
  }
  console.log(`\n${total} error${total === 1 ? "" : "s"} need review.\n`);

  const rows = db.prepare(`
    SELECT * FROM ingestion_errors WHERE resolved = 0 ORDER BY occurred_at DESC LIMIT ?
  `).all(limit) as any[];

  let i = 0;
  for (const r of rows) {
    i++;
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`Error #${i}`);
    console.log(`  Source file:    ${r.source_export_file}`);
    console.log(`  Raw input:      ${truncate(r.raw_input, 200)}`);
    console.log(`  Source:         ${r.source}`);
    console.log(`  Error type:     ${r.error_type}`);
    console.log(`  Message:        ${r.error_message}`);
    if (r.item_id) console.log(`  Item ID:        ${r.item_id}`);
  }
  if (total > limit) console.log(`\n... and ${total - limit} more. Use \`pre-kompl errors -n <count>\``);
  db.close();
}

export function cmdPartials(limit = 20): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);

  const total = (db.prepare("SELECT COUNT(*) as c FROM instances WHERE ingest_status = 'partial'").get() as any).c;
  if (total === 0) {
    console.log(`\nNo partial records.`);
    db.close();
    return;
  }

  const byReason = db.prepare(`
    SELECT partial_reason, source, COUNT(*) as c
    FROM instances WHERE ingest_status = 'partial'
    GROUP BY partial_reason, source ORDER BY c DESC
  `).all() as Array<{ partial_reason: string; source: string; c: number }>;

  console.log(`\n${total} partial record${total === 1 ? "" : "s"}. Grouped by reason:\n`);
  for (const r of byReason) {
    console.log(`  ${r.source.padEnd(10)} ${r.partial_reason ?? "(no reason)"}: ${r.c}`);
  }

  console.log(`\nFirst ${Math.min(limit, total)} examples:`);
  const examples = db.prepare(`
    SELECT id, source, kind, title, partial_reason
    FROM instances WHERE ingest_status = 'partial'
    ORDER BY fetched_at DESC LIMIT ?
  `).all(limit) as any[];
  for (const e of examples) {
    console.log(`  ${e.id.padEnd(40)} [${e.partial_reason ?? "?"}] ${truncate(e.title ?? "(no title)", 60)}`);
  }
  db.close();
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function cmdReclassify(): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const result = reclassifyAll(db);
  db.close();

  console.log(``);
  console.log(`Reclassify`);
  console.log(`─────────────────────────────────────────────`);
  console.log(`  Scanned:     ${result.scanned} instances`);
  console.log(`  Unchanged:   ${result.unchanged}`);
  const changed = result.scanned - result.unchanged;
  console.log(`  Updated:     ${changed}`);
  console.log(``);

  if (changed === 0) {
    console.log(`  Nothing to reclassify — every existing row already matches current rules.`);
    return;
  }

  console.log(`  Transitions:`);
  const entries = Object.entries(result.transitions).sort((a, b) => b[1] - a[1]);
  for (const [label, count] of entries) {
    console.log(`    ${count.toString().padStart(4)}  ${label}`);
  }
  console.log(``);
  console.log(`  Sample changes:`);
  for (const s of result.samples) {
    console.log(`    ${s.from} → ${s.to}`);
    console.log(`      ${truncate(s.url, 80)}`);
    console.log(`      (${s.reason})`);
  }
}

export interface SearchCmdOpts {
  source?: string;        // comma-separated list
  kind?: string;
  folder?: string;        // prefix
  status?: string;        // comma-separated; default 'ok'
  partial?: string;       // comma-separated partial_reasons (overrides status)
  limit?: string;         // numeric string from commander
  json?: boolean;
}

export function cmdSearch(query: string, opts: SearchCmdOpts = {}): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);

  const splitCsv = (s: string | undefined): string[] | undefined =>
    s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined;

  // --status all is the "include every status" sentinel. Cleaner than empty string.
  let statusFilter: string[] | undefined;
  if (opts.status === "all") statusFilter = [];
  else if (opts.status) statusFilter = splitCsv(opts.status);
  else statusFilter = undefined; // let searchCatalog apply its 'ok' default

  const searchOpts: SearchOptions = {
    limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
    facet_filters: {
      source: splitCsv(opts.source),
      kind: splitCsv(opts.kind),
      folder_prefix: opts.folder,
      ingest_status: statusFilter,
      partial_reason: splitCsv(opts.partial),
    },
  };

  const result = searchCatalog(db, query, searchOpts);
  db.close();

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printSearchResult(result);
}

function printSearchResult(r: SearchResult): void {
  console.log(``);
  if (r.count === 0) {
    console.log(`No results for "${r.query_raw}".`);
    if (r.query_executed) {
      console.log(`Tried: ${r.query_executed} (and relaxations) — nothing matched.`);
    }
    console.log(`Try: shorter query, different terms, or browse folders directly.`);
    return;
  }

  const headerNote = r.relaxed
    ? `${r.count} results for "${r.query_raw}" (relaxed → ${r.query_executed})`
    : `${r.count} results for "${r.query_raw}"`;
  console.log(headerNote);
  console.log(``);

  // Group by source for display (mirrors discovery-layer convention).
  const bySource = new Map<string, typeof r.items>();
  for (const h of r.items) {
    const arr = bySource.get(h.source) ?? [];
    arr.push(h);
    bySource.set(h.source, arr);
  }
  const sourceOrder = ["github", "youtube", "web", "twitter"];
  const ordered = [
    ...sourceOrder.filter((s) => bySource.has(s)),
    ...[...bySource.keys()].filter((s) => !sourceOrder.includes(s)),
  ];

  for (const src of ordered) {
    const rows = bySource.get(src)!;
    console.log(`${src.toUpperCase()} (${rows.length})`);
    for (const h of rows) {
      console.log(`  ${truncate(h.title || "(no title)", 80)}`);
      if (h.description && h.description.length > 0 &&
          !h.description.toLowerCase().startsWith((h.title ?? "").toLowerCase().slice(0, 20))) {
        console.log(`    ${truncate(h.description, 110)}`);
      }
      const folder = h.folder_paths[0] ?? "—";
      console.log(`    folder: ${folder}`);
      console.log(`    ${truncate(h.url_canonical, 90)}`);
      if (h.partial_reason) {
        console.log(`    ⚠ partial:${h.partial_reason}`);
      }
      console.log(``);
    }
  }

  if (r.count > r.items.length) {
    console.log(`  → ${r.count - r.items.length} more matching. Use --limit to see more.`);
    console.log(``);
  }

  // Facet panel — discovery-layer refinement affordance.
  const f = r.facets;
  const hasFacets =
    Object.keys(f.source).length > 1 ||
    Object.keys(f.kind).length > 1 ||
    f.folder.length > 0 ||
    f.creator.length > 0;
  if (hasFacets) {
    console.log(`Refine with:`);
    if (Object.keys(f.source).length > 1) {
      const entries = Object.entries(f.source).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} (${v})`).join(", ");
      console.log(`  --source ${entries}`);
    }
    if (f.folder.length > 0) {
      console.log(`  --folder:`);
      for (const fld of f.folder.slice(0, 6)) {
        console.log(`    "${fld.path}" (${fld.count})`);
      }
    }
    if (f.creator.length > 0) {
      console.log(`  top creators:`);
      for (const c of f.creator.slice(0, 6)) {
        console.log(`    ${c.name} (${c.count})`);
      }
    }
  }
}

export function cmdRebuildFts(): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const t0 = Date.now();
  const n = rebuildInstancesFts(db);
  const ms = Date.now() - t0;
  db.close();
  console.log(`Rebuilt instances_fts: ${n} rows in ${ms}ms.`);
}
