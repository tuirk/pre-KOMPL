// Web (misc) source pipeline.
// og-peek → JSON-LD → Firecrawl-rescue (deferred for v0; we just record fc_skipped).
import type { RawBookmark, Kind } from "../types.js";
import type { IngestContext } from "../context.js";
import { upsertInstanceFts } from "../db.js";
import { canonicalizeWeb } from "../canonicalize.js";
import { ogPeek, isBrandDefaultTitle } from "../parsers/web-peek.js";
import { fcScrape } from "../firecrawl.js";
import { createWorkForInstance, newItemId, findOrCreateCreatorAuthority } from "../authorities.js";
import { buildItemCompositeKey, findFolderRenameCandidate } from "../dedup.js";

const DONT_RETRY_HOSTS = new Set([
  "nytimes.com", "ft.com", "wsj.com", "bloomberg.com",
  "wired.com", "newyorker.com", "economist.com", "stratechery.com",
]);

export async function ingestWeb(ctx: IngestContext, bookmarks: RawBookmark[]): Promise<void> {
  ctx.emit({ kind: "pipeline_start", source: "web", total: bookmarks.length });

  let created = 0;
  let deduped = 0;

  for (let i = 0; i < bookmarks.length; i++) {
    const bm = bookmarks[i];
    if (i > 0 && i % 50 === 0) {
      ctx.emit({ kind: "pipeline_progress", source: "web", done: i, total: bookmarks.length });
    }
    try {
      const r = await ingestOne(ctx, bm);
      if (r === "created") created++;
      else if (r === "deduped") deduped++;
    } catch (e: any) {
      ctx.recordError({
        source: "web",
        raw_input: JSON.stringify(bm).slice(0, 1024),
        source_export_file: bm.source_export_file,
        classification_attempt: "web",
        error_type: "parse_exception",
        error_message: e?.message ?? "unknown",
        exception_traceback: e?.stack,
      });
    }
  }
  ctx.emit({ kind: "pipeline_done", source: "web", created, deduped });
  ctx.bySource.web += created;
}

async function ingestOne(ctx: IngestContext, bm: RawBookmark): Promise<"created" | "deduped" | "error"> {
  const canon = canonicalizeWeb(bm.url);
  if (!canon) {
    ctx.recordError({
      source: "web",
      raw_input: bm.url,
      source_export_file: bm.source_export_file,
      classification_attempt: "web",
      error_type: "malformed_url",
      error_message: `Could not canonicalize URL: ${bm.url}`,
    });
    return "error";
  }

  const instanceId = `inst_web_${hashShort(canon.canonical)}`;
  const alreadySeen = ctx.hasSeenInstance("web", canon.nativeId);

  // Dedup at Instance level
  if (alreadySeen) {
    // Create new Item if composite not already present (handles re-ingest with new save_date or folder)
    upsertItem(ctx, "web", instanceId, bm, canon.canonical);
    return "deduped";
  }

  // Decide whether to call og-peek (network) or skip (Firecrawl out for v0 + offline)
  const host = safeHost(canon.canonical);
  const isDontRetry = host ? DONT_RETRY_HOSTS.has(host) : false;

  let title: string | null = bm.title;
  let titleSource: string | null = bm.title ? "browser_bookmark" : null;
  let description: string | null = null;
  let descriptionSource: string | null = null;
  let imageUrl: string | null = null;
  let author: string | null = null;
  let language: string | null = null;
  let peekStatus = "peek_skipped"; // default when we don't peek (paywalled host)
  let ingestStatus: "ok" | "partial" = "partial";
  let partialReason: string | null = "peek_not_attempted";
  let kind: Kind = "other";
  let fcCalled = false;
  let fcStatus: string | null = null; // "success" or failure_reason; null when not called

  const shouldPeek = !isDontRetry; // v0: skip paywall hosts entirely
  if (shouldPeek) {
    try {
      const peek = await ogPeek(canon.canonical);
      peekStatus = peek.status;
      if (peek.status === "ok") {
        title = peek.title ?? bm.title;
        titleSource = peek.title_source ?? titleSource;
        description = peek.description;
        descriptionSource = peek.description_source;
        imageUrl = peek.image_url;
        author = peek.author;
        language = peek.language;
        // Kind heuristics
        if (peek.json_ld_types.some((t) => /Article|NewsArticle|BlogPosting/.test(t))) kind = "article";
        else if (peek.json_ld_types.some((t) => /ScholarlyArticle/.test(t))) kind = "paper";
        else if (peek.og_type === "article") kind = "article";
        // partial vs ok
        const brandDefault = isBrandDefaultTitle(title, canon.canonical);
        if (brandDefault) {
          ingestStatus = "partial";
          partialReason = "brand_default_title";
        } else {
          ingestStatus = "ok";
          partialReason = null;
        }
      } else if (peek.status === "not_html") {
        ingestStatus = "partial";
        partialReason = "not_html";
        kind = "other";
      } else {
        ingestStatus = "partial";
        partialReason = peek.status; // "blocked" | "no_og_tags" | "failed"
      }
    } catch (e: any) {
      peekStatus = "failed";
      partialReason = "peek_exception";
    }
  } else {
    ingestStatus = "partial";
    partialReason = "paywalled";
    kind = "paywalled";
  }

  // ── Firecrawl rescue ─────────────────────────────────────────────────────
  // If og-peek couldn't extract usable metadata, retry via Firecrawl which
  // executes JS and gets past most anti-bot measures. Costs 1 credit per call.
  //
  // Eligible cases (from the audit):
  //   - blocked: peek got non-200 (Cloudflare, anti-bot 403s)
  //   - failed / peek_exception: connection error or timeout
  //   - no_og_tags: page rendered with JS that peek can't see
  //   - brand_default_title: peek returned only the brand string for a deep URL
  //
  // Skip if: Firecrawl disabled (no key), paywalled host (already filtered above
  // by the !shouldPeek branch), not_html (PDFs need separate extraction), or
  // per-run budget exhausted.
  const rescueEligible =
    partialReason === "blocked" ||
    partialReason === "failed" ||
    partialReason === "peek_exception" ||
    partialReason === "no_og_tags" ||
    partialReason === "brand_default_title";
  const budgetRemaining = ctx.config.firecrawlBudget - ctx.firecrawlCreditsUsed;
  const fcReady = ctx.config.firecrawlEnabled && !!ctx.config.firecrawlApiKey && budgetRemaining > 0;
  let fcStatusCode: number | null = null;
  if (rescueEligible && fcReady) {
    fcCalled = true;
    ctx.firecrawlCreditsUsed++;
    const fc = await fcScrape(canon.canonical, ctx.config.firecrawlApiKey!);
    fcStatus = fc.success ? "success" : (fc.failure_reason ?? "unknown_failure");
    fcStatusCode = fc.status_code;

    // Hard dead-link check FIRST — fires whenever FC sees upstream HTTP ≥ 400,
    // even if FC couldn't extract a title from the error page. (Some 404 pages
    // have no <title> tag at all; we'd previously miss those and keep peek's
    // "blocked" reason, which is misleading — the page isn't blocked, it's gone.)
    if (fc.success && fc.status_code !== null && fc.status_code >= 400) {
      ingestStatus = "partial";
      partialReason = "dead_link";
      // Still populate any title FC managed to extract — useful for audits even
      // if the page is dead. ("Chart Not Found — TradingView" is more informative
      // than a null title when bestie scans the partials view.)
      if (fc.title) {
        title = fc.title;
        titleSource = "firecrawl";
        if (fc.description) { description = fc.description; descriptionSource = "firecrawl"; }
        if (fc.image_url) imageUrl = fc.image_url;
        if (fc.author) author = fc.author;
        if (fc.language) language = fc.language;
      }
    } else if (fc.success && fc.title) {
      // Live page with a real title — Firecrawl rescued usable data.
      title = fc.title;
      titleSource = "firecrawl";
      if (fc.description) {
        description = fc.description;
        descriptionSource = "firecrawl";
      }
      if (fc.image_url) imageUrl = fc.image_url;
      if (fc.author) author = fc.author;
      if (fc.language) language = fc.language;

      // Re-evaluate brand-default with the Firecrawl-extracted title.
      const stillBrandDefault = isBrandDefaultTitle(title, canon.canonical);
      if (stillBrandDefault) {
        ingestStatus = "partial";
        partialReason = "brand_default_title";
      } else {
        ingestStatus = "ok";
        partialReason = null;
      }
    }
    // If fc.success === false OR (fc.success && no title && no error status): keep peek's partial state.
    // source_payload below records the fc attempt outcome so it's visible in audits.
  } else if (rescueEligible && ctx.config.firecrawlEnabled && budgetRemaining <= 0) {
    // Firecrawl is configured but we've burned through the budget this run.
    fcStatus = "budget_exhausted";
  }

  // ── Soft dead-link check (applies to both peek and FC results) ──────────
  // Catches "soft 404s" — pages that return HTTP 200 but whose content is
  // a "Page Not Found" error template. The hard status_code check above misses
  // these because the server lied about the status. Run only on instances
  // we're about to mark ok, so we don't downgrade already-partial records.
  if (ingestStatus === "ok" && title && looksLikeDeadLinkTitle(title)) {
    ingestStatus = "partial";
    partialReason = "dead_link";
  }

  // Create Work + Instance + Item
  const workId = createWorkForInstance(ctx.db, title, description);

  // Author → creator authority (best-effort)
  let creatorAuthorityId: string | null = null;
  if (author && author.length > 0 && author.length < 200) {
    creatorAuthorityId = findOrCreateCreatorAuthority(
      ctx.db,
      "web",
      author,
      `${slugify(author)}_${host ?? "unknown"}`,
      { variants: [], external_ids: host ? { host } : undefined }
    );
    ctx.authoritiesTouched.add(creatorAuthorityId);
  }

  const sourcePayload = {
    title_source: titleSource,
    description_source: descriptionSource,
    image_url: imageUrl,
    language,
    peek_status: peekStatus,
    fc_called: fcCalled,
    fc_status: fcStatus,
    fc_status_code: fcStatusCode,
  };

  ctx.db.prepare(`
    INSERT INTO instances (
      id, source, kind, native_id, url_canonical,
      title, description, source_payload_json,
      creator_authority_id, subject_authority_ids_json,
      work_id, access_status, is_archived_url,
      ingest_status, partial_reason, fetched_at
    )
    VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 0, ?, ?, ?)
  `).run(
    instanceId, kind, canon.nativeId, canon.canonical,
    title, description, JSON.stringify(sourcePayload),
    creatorAuthorityId,
    workId,
    isDontRetry ? "paywalled" : "live",
    ingestStatus, partialReason, Date.now()
  );

  ctx.markInstanceSeen("web", canon.nativeId);
  ctx.instancesCreated++;
  ctx.byStatus[ingestStatus]++;

  upsertItem(ctx, "web", instanceId, bm, canon.canonical);
  return "created";
}

function upsertItem(
  ctx: IngestContext,
  source: "web" | "youtube" | "github" | "twitter",
  instanceId: string,
  bm: RawBookmark,
  canonicalUrl: string
): void {
  // Folder-rename check: Web only and only when save_date present
  if (source === "web") {
    const renameOf = findFolderRenameCandidate(
      ctx.db, instanceId, bm.url, bm.save_date, bm.bookmark_folder_path
    );
    if (renameOf) {
      ctx.db.prepare(
        "UPDATE items SET bookmark_folder_path = ?, ingested_at = ? WHERE id = ?"
      ).run(bm.bookmark_folder_path, Date.now(), renameOf);
      // Folder path changed → refresh FTS so folder_paths reflects the rename.
      upsertInstanceFts(ctx.db, instanceId);
      return;
    }
  }

  // Check item composite existence
  const key = buildItemCompositeKey(source, instanceId, bm.url, bm.save_date, bm.bookmark_folder_path);
  const exists = checkItemComposite(ctx, source, instanceId, bm);
  if (exists) return; // dedup hit — no folder change, no FTS refresh needed

  const itemId = newItemId();
  ctx.db.prepare(`
    INSERT INTO items (
      id, instance_id, url_as_saved, url_canonical,
      save_date, save_date_is_inferred,
      bookmark_folder_path, user_notes,
      source_export_file, ingested_at, ingest_status, ingest_error_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', NULL)
  `).run(
    itemId, instanceId, bm.url, canonicalUrl,
    bm.save_date, bm.save_date_is_inferred ? 1 : 0,
    bm.bookmark_folder_path, bm.user_notes,
    bm.source_export_file, Date.now()
  );
  ctx.itemsCreated++;
  // New item → folder_paths on this instance's FTS row may now include a new
  // folder. Refresh. (Idempotent if the folder was already covered.)
  upsertInstanceFts(ctx.db, instanceId);
}

function checkItemComposite(
  ctx: IngestContext,
  source: "web" | "youtube" | "github" | "twitter",
  instanceId: string,
  bm: RawBookmark
): boolean {
  if (source === "twitter") {
    return !!ctx.db.prepare(
      "SELECT id FROM items WHERE instance_id = ? AND url_as_saved = ? LIMIT 1"
    ).get(instanceId, bm.url);
  }
  if (source === "web") {
    return !!ctx.db.prepare(
      `SELECT id FROM items
       WHERE instance_id = ? AND url_as_saved = ? AND save_date = ? AND bookmark_folder_path = ?
       LIMIT 1`
    ).get(instanceId, bm.url, bm.save_date, bm.bookmark_folder_path);
  }
  // youtube / github
  return !!ctx.db.prepare(
    `SELECT id FROM items
     WHERE instance_id = ? AND url_as_saved = ? AND save_date = ?
     LIMIT 1`
  ).get(instanceId, bm.url, bm.save_date);
}

function hashShort(s: string): string {
  // Simple non-crypto hash for ID generation. Stable, short.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(7, "0").slice(0, 10);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

// Soft dead-link detection: catches pages that returned HTTP 200 but whose
// title is a "Page Not Found" template ("soft 404s"). Many sites do this —
// serve a real status 200 with a styled error page. Real article titles
// virtually never start or end with these phrases.
//
// We use \b word boundaries to avoid false-positives on titles like
// "How to Recover Files When Not Found" (article about file recovery, not a 404).
const DEAD_LINK_PATTERNS: RegExp[] = [
  /\bnot found\b/i,            // "page not found", "post not found", "chart not found"
  /\b404\b.*\b(page|error|not found)\b/i,  // "404 page" / "Error 404"
  /\b(page|post|article) (no longer (exists|available)|does(n['']?t| not) exist)\b/i,
  /^error\s*[-–—:|]/i,         // "Error - Some Site" / "Error: Page missing"
];

export function looksLikeDeadLinkTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return false;
  for (const re of DEAD_LINK_PATTERNS) if (re.test(t)) return true;
  return false;
}

function safeHost(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

// Export helpers used by other source pipelines (they reuse the upsertItem / dedup logic)
export { upsertItem, checkItemComposite, hashShort };
