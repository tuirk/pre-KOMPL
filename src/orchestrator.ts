// Orchestrator: folder scan → file classification → URL classification → pipeline dispatch.
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, basename } from "node:path";
import type { FileClassification, RawBookmark, Source, IngestSummary } from "./types.js";
import { IngestContext, type ProgressEvent } from "./context.js";
import { openDb, loadSeenInstances } from "./db.js";
import { loadConfig } from "./config.js";
import { classifyUrl } from "./url-classify.js";
import { isNetscapeBookmarksFile, parseBookmarksHtml } from "./parsers/browser-bookmarks.js";
import { extractUrlsFromText, urlsToRawBookmarks, decodeText, looksLikeBinary } from "./parsers/notes-file.js";
import { detectAndParseAll } from "./parsers/twitter-parser.js";
import { ingestYouTube } from "./sources/youtube.js";
import { ingestGithub } from "./sources/github.js";
import { ingestTwitter, ingestTwitterFromBookmarks } from "./sources/twitter.js";
import { ingestWeb } from "./sources/web.js";

// Pre-classify a file by content sniffing.
export function classifyFile(path: string): FileClassification {
  const filename = basename(path);
  let stat;
  try { stat = statSync(path); } catch (e) {
    return { path, filename, type: "unrecognized", entry_count: 0, reason: "cannot_stat" };
  }
  if (stat.size === 0) return { path, filename, type: "empty", entry_count: 0, reason: "zero_bytes" };

  let buf: Buffer;
  try { buf = readFileSync(path); } catch {
    return { path, filename, type: "unrecognized", entry_count: 0, reason: "cannot_read" };
  }

  if (looksLikeBinary(buf)) {
    return { path, filename, type: "binary", entry_count: 0, reason: "non_printable_bytes" };
  }
  const text = decodeText(buf);
  if (text === null) {
    return { path, filename, type: "binary", entry_count: 0, reason: "encoding_fail" };
  }

  // Twitter JSON?
  if (filename.endsWith(".json") || /^\s*[\[{]/.test(text)) {
    try {
      const { tweets, skipped } = detectAndParseAll(text);
      if (tweets.length + skipped.length > 0) {
        return { path, filename, type: "twitter_json", entry_count: tweets.length + skipped.length };
      }
    } catch { /* fall through to notes */ }
  }

  // Browser bookmarks?
  if (isNetscapeBookmarksFile(text)) {
    const parsed = parseBookmarksHtml(text, filename);
    return { path, filename, type: "browser_bookmarks", entry_count: parsed.length };
  }

  // Notes file
  const urls = extractUrlsFromText(text);
  if (urls.length === 0) {
    return { path, filename, type: "empty", entry_count: 0, reason: "no_urls_found" };
  }
  return { path, filename, type: "notes", entry_count: urls.length };
}

// Recurses into subfolders so an export tree can be pointed at as-is.
// Dotfiles/dotdirs (.git, .DS_Store) and node_modules are skipped.
export function scanFolder(folder: string): FileClassification[] {
  let entries: Dirent[];
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch (e: any) {
    throw new Error(`Cannot read folder: ${folder} (${e.message})`);
  }
  const out: FileClassification[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) out.push(...scanFolder(path));
    else out.push(classifyFile(path));
  }
  return out;
}

export async function ingestFolder(
  folder: string,
  onProgress?: (e: ProgressEvent) => void
): Promise<IngestSummary> {
  const startedAt = Date.now();
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const seenInstances = loadSeenInstances(db);
  const ctx = new IngestContext(db, config, seenInstances);
  ctx.onProgress = onProgress ?? null;

  // 1. Scan
  const files = scanFolder(folder);
  for (const f of files) {
    ctx.emit({ kind: "file_scan", path: f.path, type: f.type, entries: f.entry_count, reason: f.reason });
  }

  // 2. Aggregate raw bookmarks across all files, plus parsed tweets separately
  const allBookmarks: RawBookmark[] = [];
  const allParsedTweets: { tweets: any[]; sourceFile: string }[] = [];
  const ingestTime = Date.now();

  for (const f of files) {
    if (f.type === "browser_bookmarks") {
      const content = readFileSync(f.path, "utf-8");
      const parsed = parseBookmarksHtml(content, f.filename);
      allBookmarks.push(...parsed);
      ctx.filesProcessed++;
    } else if (f.type === "twitter_json") {
      const content = readFileSync(f.path, "utf-8");
      try {
        const { tweets, skipped } = detectAndParseAll(content);
        allParsedTweets.push({ tweets: [...tweets, ...skipped], sourceFile: f.filename });
        ctx.filesProcessed++;
      } catch (e: any) {
        ctx.recordError({
          source: "twitter", raw_input: `(file ${f.filename})`, source_export_file: f.filename,
          classification_attempt: "twitter_json", error_type: "parse_exception",
          error_message: e?.message ?? "twitter parse failed",
        });
      }
    } else if (f.type === "notes") {
      const buf = readFileSync(f.path);
      const text = decodeText(buf);
      if (text === null) { ctx.filesSkipped++; continue; }
      const urls = extractUrlsFromText(text);
      const bookmarks = urlsToRawBookmarks(urls, f.filename, ingestTime);
      allBookmarks.push(...bookmarks);
      ctx.filesProcessed++;
    } else {
      ctx.filesSkipped++;
    }
  }

  // 3. URL-classify and group by source
  const byPipe: Record<Source, RawBookmark[]> = { youtube: [], github: [], twitter: [], web: [] };
  const shorteners: RawBookmark[] = [];

  for (const bm of allBookmarks) {
    const cls = classifyUrl(bm.url);
    if (cls.kind === "routed") {
      byPipe[cls.source].push(bm);
    } else if (cls.kind === "gist") {
      // Out-of-scope routing: record as error so it's visible
      ctx.recordError({
        source: "github", raw_input: bm.url, source_export_file: bm.source_export_file,
        classification_attempt: "github_gist", error_type: "unsupported_url",
        error_message: "Gists aren't supported yet (preserved as URL only)",
      });
    } else if (cls.kind === "shortener") {
      shorteners.push(bm);
    } else {
      ctx.recordError({
        source: "unclassified", raw_input: bm.url, source_export_file: bm.source_export_file,
        classification_attempt: null, error_type: "unsupported_url",
        error_message: cls.reason,
      });
    }
  }

  // Shorteners: punt to web pipeline as-is (they'll resolve via fetch redirect)
  byPipe.web.push(...shorteners);

  // 4. Run pipelines (parallel where independent; sequential here for simplicity)
  if (byPipe.youtube.length > 0) await ingestYouTube(ctx, byPipe.youtube);
  if (byPipe.github.length > 0)  await ingestGithub(ctx, byPipe.github);

  // Real Twitter exports first — their rich data populates the Instance.
  for (const { tweets, sourceFile } of allParsedTweets) {
    ingestTwitter(ctx, tweets, sourceFile);
  }
  // Then URL-only entries from browser bookmarks / notes files.
  // ingestTwitterFromBookmarks preserves the browser-bookmark title, save_date,
  // and folder path. For tweets already in the DB from the export step above,
  // this just adds an Item against the existing Instance.
  if (byPipe.twitter.length > 0) {
    ingestTwitterFromBookmarks(ctx, byPipe.twitter);
  }
  if (byPipe.web.length > 0)     await ingestWeb(ctx, byPipe.web);

  // 5. Summary
  const summary: IngestSummary = {
    files_processed: ctx.filesProcessed,
    files_skipped: ctx.filesSkipped,
    items_created: ctx.itemsCreated,
    instances_created: ctx.instancesCreated,
    authorities_created_or_referenced: ctx.authoritiesTouched.size,
    by_status: ctx.byStatus,
    by_source: ctx.bySource,
    elapsed_ms: Date.now() - startedAt,
    quota: {
      ...(ctx.youtubeUnitsUsed > 0 ? { youtube_units: ctx.youtubeUnitsUsed } : {}),
      ...(ctx.githubRequestsUsed > 0 ? { github_requests: ctx.githubRequestsUsed } : {}),
      ...(ctx.firecrawlCreditsUsed > 0 ? { firecrawl_credits: ctx.firecrawlCreditsUsed } : {}),
    },
  };
  ctx.emit({ kind: "ingest_done", summary });
  db.close();
  return summary;
}
