// Twitter source pipeline.
// Consumes already-parsed ParsedTweet[] from the vendor-copied twitter-parser.
// No live API. Bookmark export JSON is the only input.
import type { RawBookmark } from "../types.js";
import type { IngestContext } from "../context.js";
import type { ParsedTweet } from "../parsers/twitter-parser.js";
import { canonicalizeTwitter } from "../canonicalize.js";
import { createWorkForInstance, findOrCreateCreatorAuthority } from "../authorities.js";
import { upsertItem } from "./web.js";

// Called from orchestrator with parsed tweets from twitter-parser
export function ingestTwitter(
  ctx: IngestContext,
  parsedTweets: ParsedTweet[],
  sourceFile: string
): void {
  ctx.emit({ kind: "pipeline_start", source: "twitter", total: parsedTweets.length });
  let created = 0;
  let deduped = 0;

  for (const tweet of parsedTweets) {
    const url = tweet.tweet_url;
    if (!url) {
      ctx.recordError({
        source: "twitter", raw_input: JSON.stringify(tweet).slice(0, 512),
        source_export_file: sourceFile, classification_attempt: "twitter",
        error_type: "no_url", error_message: "Parsed tweet has no tweet_url",
      });
      continue;
    }
    const canon = canonicalizeTwitter(url);
    if (!canon) {
      ctx.recordError({
        source: "twitter", raw_input: url,
        source_export_file: sourceFile, classification_attempt: "twitter",
        error_type: "malformed_url", error_message: `Could not parse tweet URL: ${url}`,
      });
      continue;
    }

    // RawBookmark for Item creation. save_date is the ingest time (we don't know when bestie bookmarked it).
    const bm: RawBookmark = {
      url,
      title: null,
      save_date: Date.now(),
      save_date_is_inferred: true,
      bookmark_folder_path: "",
      user_notes: null,
      source_export_file: sourceFile,
    };

    const seen = ctx.hasSeenInstance("twitter", canon.nativeId);
    const instanceId = `inst_tw_${canon.nativeId}`;
    if (seen) {
      deduped++;
      upsertItem(ctx, "twitter", instanceId, bm, canon.canonical);
      continue;
    }

    // Build creator authority (thin — handle only)
    let creatorAuthorityId: string | null = null;
    if (tweet.author) {
      const handle = tweet.author.replace(/^@/, "");
      creatorAuthorityId = findOrCreateCreatorAuthority(
        ctx.db, "twitter", handle, handle,
        { variants: [tweet.author], external_ids: { twitter_handle: handle } }
      );
      ctx.authoritiesTouched.add(creatorAuthorityId);
    }

    const text = tweet.text ?? "";
    const isEmpty = !text.trim();
    const looksTruncated = !isEmpty && /\b(and|or|but|the|a|to|of|in|for|with|on)\s*$/i.test(text);
    const textStatus = isEmpty ? "empty" : looksTruncated ? "truncated" : "ok";

    const sourcePayload = {
      tweet_id: canon.nativeId,
      handle: tweet.author?.replace(/^@/, "") ?? null,
      created_at_iso: tweet.date,
      text_status: textStatus,
      is_text_complete: !looksTruncated && !isEmpty,
      tco_urls: tweet.urls ?? [],
      card_title: tweet.card_title ?? null,
      card_description: tweet.card_description ?? null,
    };

    const workId = createWorkForInstance(ctx.db, text.slice(0, 100) || (tweet.author ?? "tweet"), null);

    ctx.db.prepare(`
      INSERT INTO instances (
        id, source, kind, native_id, url_canonical,
        title, description, source_payload_json,
        creator_authority_id, subject_authority_ids_json,
        work_id, access_status, is_archived_url,
        ingest_status, partial_reason, fetched_at
      )
      VALUES (?, 'twitter', 'tweet', ?, ?, ?, ?, ?, ?, '[]', ?, 'live', 0, ?, ?, ?)
    `).run(
      instanceId, canon.nativeId, canon.canonical,
      text.slice(0, 280), text.length > 280 ? text.slice(280) : null,
      JSON.stringify(sourcePayload),
      creatorAuthorityId, workId,
      isEmpty || looksTruncated ? "partial" : "ok",
      isEmpty ? "empty_text" : looksTruncated ? "truncated_text" : null,
      Date.now()
    );

    ctx.markInstanceSeen("twitter", canon.nativeId);
    ctx.instancesCreated++;
    ctx.byStatus[isEmpty || looksTruncated ? "partial" : "ok"]++;

    upsertItem(ctx, "twitter", instanceId, bm, canon.canonical);
    created++;
  }
  ctx.emit({ kind: "pipeline_done", source: "twitter", created, deduped });
}

// Variant for tweet URLs that arrive via browser bookmarks or notes files
// (not from a Twitter JSON export). Each RawBookmark carries the browser's saved
// title, the original add_date, and the folder path — all of which we preserve.
//
// When the same tweet exists in a real export AND a browser bookmark, the export
// pipeline should run first (rich data wins) and this function just upserts an Item
// against the existing Instance. When the tweet is *only* in a browser bookmark,
// we create a partial Instance with the browser title (better than empty).
export function ingestTwitterFromBookmarks(
  ctx: IngestContext,
  bookmarks: RawBookmark[]
): void {
  ctx.emit({ kind: "pipeline_start", source: "twitter", total: bookmarks.length });
  let created = 0;
  let deduped = 0;

  for (const bm of bookmarks) {
    const canon = canonicalizeTwitter(bm.url);
    if (!canon) {
      ctx.recordError({
        source: "twitter", raw_input: bm.url,
        source_export_file: bm.source_export_file, classification_attempt: "twitter",
        error_type: "malformed_url", error_message: `Could not parse tweet URL: ${bm.url}`,
      });
      continue;
    }

    const instanceId = `inst_tw_${canon.nativeId}`;
    if (ctx.hasSeenInstance("twitter", canon.nativeId)) {
      // Instance exists (from a real export or earlier in this run). Just upsert Item.
      deduped++;
      upsertItem(ctx, "twitter", instanceId, bm, canon.canonical);
      continue;
    }

    // New Instance from browser bookmark only. Use bm.title as the Instance title —
    // it's the best we have without a Twitter export. Mark partial with empty_text so
    // bestie can see this Instance hasn't been enriched by a tweet export yet.
    const title = bm.title ?? "";
    const workId = createWorkForInstance(ctx.db, title || "tweet", null);

    const sourcePayload = {
      tweet_id: canon.nativeId,
      handle: null,
      created_at_iso: null,
      text_status: "empty",
      is_text_complete: false,
      tco_urls: [],
      card_title: null,
      card_description: null,
      title_source: bm.title ? "browser_bookmark" : null,
    };

    ctx.db.prepare(`
      INSERT INTO instances (
        id, source, kind, native_id, url_canonical,
        title, description, source_payload_json,
        creator_authority_id, subject_authority_ids_json,
        work_id, access_status, is_archived_url,
        ingest_status, partial_reason, fetched_at
      )
      VALUES (?, 'twitter', 'tweet', ?, ?, ?, NULL, ?, NULL, '[]', ?, 'live', 0, 'partial', 'empty_text', ?)
    `).run(
      instanceId, canon.nativeId, canon.canonical,
      title || null,
      JSON.stringify(sourcePayload),
      workId, Date.now()
    );

    ctx.markInstanceSeen("twitter", canon.nativeId);
    ctx.instancesCreated++;
    ctx.byStatus.partial++;

    upsertItem(ctx, "twitter", instanceId, bm, canon.canonical);
    created++;
  }
  ctx.emit({ kind: "pipeline_done", source: "twitter", created, deduped });
}
