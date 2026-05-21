// YouTube source pipeline.
// videos.list (50 ids/batch, 1 unit each), channels.list (cached per creator).
// Gracefully degrades when YOUTUBE_API_KEY is absent — records Instance as partial.
import type { RawBookmark, Kind } from "../types.js";
import type { IngestContext } from "../context.js";
import { canonicalizeYoutube } from "../canonicalize.js";
import { createWorkForInstance, findOrCreateCreatorAuthority } from "../authorities.js";
import { findYoutubeAuthorityByHandle } from "../authority-lookup.js";
import { upsertItem, hashShort } from "./web.js";

interface VideoApiPayload {
  videoId: string;
  title: string | null;
  description: string | null;
  channelId: string | null;
  channelTitle: string | null;
  categoryId: string | null;
  tags: string[];
  duration: string | null;
  viewCount: number | null;
  likeCount: number | null;
  topicCategories: string[];
  publishedAt: string | null;
  wasLivestream: boolean;
  isLiveNow: boolean;
  language: string | null;
  thumbnails: any;
}

interface ChannelApiPayload {
  channelId: string;
  title: string;
  description: string | null;
  customUrl: string | null;
  country: string | null;
  thumbnail: string | null;
  topicCategories: string[];
  subscriberCount: number | null;
  videoCount: number | null;
}

export async function ingestYouTube(ctx: IngestContext, bookmarks: RawBookmark[]): Promise<void> {
  ctx.emit({ kind: "pipeline_start", source: "youtube", total: bookmarks.length });

  // Group ALL incoming bookmarks by nativeId so duplicates within this run share an Instance.
  // For each native_id: one Instance gets created (or skipped if already in DB);
  // N Items get created (one per RawBookmark).
  const groupedByNativeId = new Map<string, {
    kind: "video" | "video-playlist" | "creator-page";
    canonical: string;
    bookmarks: RawBookmark[];
  }>();
  let dedupHits = 0;

  for (const bm of bookmarks) {
    const canon = canonicalizeYoutube(bm.url);
    if (!canon) {
      ctx.recordError({
        source: "youtube",
        raw_input: bm.url,
        source_export_file: bm.source_export_file,
        classification_attempt: "youtube",
        // URL parses fine; it just doesn't match a recognized YouTube pattern
        // (bare /, deleted /watch?v=, etc.). "unsupported_url" reflects this better
        // than "malformed_url" — malformed = bad syntax, which url-classify catches earlier.
        error_type: "unsupported_url",
        error_message: `URL is valid but does not match a supported YouTube pattern (video/channel/playlist/shorts/live/embed): ${bm.url}`,
      });
      continue;
    }
    const existing = groupedByNativeId.get(canon.nativeId);
    if (existing) {
      existing.bookmarks.push(bm);
    } else {
      groupedByNativeId.set(canon.nativeId, {
        kind: canon.kind,
        canonical: canon.canonical,
        bookmarks: [bm],
      });
    }
  }

  // Split: groups whose Instance is already in DB (dedup hits — just create Items)
  // vs groups whose Instance needs to be created.
  const newVideos: { nativeId: string; canonical: string; bookmarks: RawBookmark[] }[] = [];
  const newPlaylists: { nativeId: string; canonical: string; bookmarks: RawBookmark[] }[] = [];
  const newChannels: { nativeId: string; canonical: string; bookmarks: RawBookmark[] }[] = [];

  for (const [nativeId, group] of groupedByNativeId) {
    if (ctx.hasSeenInstance("youtube", nativeId)) {
      const instanceId = `inst_yt_${nativeId}`;
      for (const bm of group.bookmarks) {
        upsertItem(ctx, "youtube", instanceId, bm, group.canonical);
        dedupHits++;
      }
      continue;
    }
    if (group.kind === "video") newVideos.push({ nativeId, canonical: group.canonical, bookmarks: group.bookmarks });
    else if (group.kind === "video-playlist") newPlaylists.push({ nativeId, canonical: group.canonical, bookmarks: group.bookmarks });
    else newChannels.push({ nativeId, canonical: group.canonical, bookmarks: group.bookmarks });
  }

  const apiKey = ctx.config.youtubeApiKey;

  // Without API key, record videos/playlists as partial; channels still get
  // a chance at local-authority match (which needs no API). Only the API-bound
  // resolution steps (forHandle/forUsername) are skipped.
  if (!apiKey) {
    for (const g of newVideos) createPartialNoApiInstanceForGroup(ctx, g, "video");
    for (const g of newPlaylists) createPartialNoApiInstanceForGroup(ctx, g, "video-playlist");
    for (const g of newChannels) await resolveChannelPageGroup(ctx, g, new Map(), null);
    ctx.emit({
      kind: "pipeline_done", source: "youtube",
      created: newVideos.length + newPlaylists.length + newChannels.length,
      deduped: dedupHits,
    });
    return;
  }

  // With API key: batch videos.list (50 per call)
  const videoApiData = await fetchVideos(ctx, newVideos.map((v) => v.nativeId), apiKey);
  const channelIds = new Set<string>();
  for (const v of videoApiData) if (v.channelId) channelIds.add(v.channelId);
  for (const g of newChannels) if (!g.nativeId.startsWith("@")) channelIds.add(g.nativeId);
  const channelApiData = await fetchChannels(ctx, [...channelIds], apiKey);
  const channelById = new Map(channelApiData.map((c) => [c.channelId, c]));

  for (const g of newVideos) {
    const v = videoApiData.find((x) => x.videoId === g.nativeId);
    if (!v) {
      createPartialNoApiInstanceForGroup(ctx, g, "video", "video_not_returned_by_api");
      continue;
    }
    const channel = v.channelId ? (channelById.get(v.channelId) ?? null) : null;
    createVideoInstanceForGroup(ctx, g, v, channel);
  }

  // Playlists: playlists.list?id=... (1 unit/call, batched up to 50 IDs)
  if (newPlaylists.length > 0) {
    const playlistApiData = await fetchPlaylists(ctx, newPlaylists.map((p) => p.nativeId), apiKey);
    const playlistById = new Map(playlistApiData.map((p) => [p.playlistId, p]));
    // Channel IDs from playlists need fetching too (for creator authority)
    const extraChannelIds = new Set<string>();
    for (const p of playlistApiData) if (p.channelId && !channelById.has(p.channelId)) extraChannelIds.add(p.channelId);
    if (extraChannelIds.size > 0) {
      const extraChannels = await fetchChannels(ctx, [...extraChannelIds], apiKey);
      for (const ch of extraChannels) channelById.set(ch.channelId, ch);
    }
    for (const g of newPlaylists) {
      const p = playlistById.get(g.nativeId);
      if (!p) {
        createPartialNoApiInstanceForGroup(ctx, g, "video-playlist", "playlist_not_returned_by_api");
        continue;
      }
      const channel = p.channelId ? (channelById.get(p.channelId) ?? null) : null;
      createPlaylistInstanceForGroup(ctx, g, p, channel);
    }
  }

  // Channel pages: resolve via local custom-URL match (free), then API forHandle/forUsername.
  // The local match consolidates dupes when bestie also bookmarked videos by the same channel.
  for (const g of newChannels) {
    await resolveChannelPageGroup(ctx, g, channelById, apiKey);
  }

  ctx.emit({
    kind: "pipeline_done", source: "youtube",
    created: newVideos.length + newPlaylists.length + newChannels.length,
    deduped: dedupHits,
  });
}

async function fetchVideos(ctx: IngestContext, videoIds: string[], apiKey: string): Promise<VideoApiPayload[]> {
  const out: VideoApiPayload[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails,statistics,topicDetails,status");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);
    try {
      const resp = await fetch(url.toString());
      ctx.youtubeUnitsUsed++;
      if (!resp.ok) {
        ctx.recordError({
          source: "youtube", raw_input: batch.join(","),
          source_export_file: "(batch)", classification_attempt: "youtube.videos.list",
          error_type: "fetch_failure_total",
          error_message: `videos.list ${resp.status} ${resp.statusText}`,
        });
        continue;
      }
      const data = await resp.json() as any;
      for (const item of data.items ?? []) {
        out.push({
          videoId: item.id,
          title: item.snippet?.title ?? null,
          description: item.snippet?.description ?? null,
          channelId: item.snippet?.channelId ?? null,
          channelTitle: item.snippet?.channelTitle ?? null,
          categoryId: item.snippet?.categoryId ?? null,
          tags: item.snippet?.tags ?? [],
          duration: item.contentDetails?.duration ?? null,
          viewCount: item.statistics?.viewCount ? Number(item.statistics.viewCount) : null,
          likeCount: item.statistics?.likeCount ? Number(item.statistics.likeCount) : null,
          topicCategories: item.topicDetails?.topicCategories ?? [],
          publishedAt: item.snippet?.publishedAt ?? null,
          wasLivestream: !!item.liveStreamingDetails,
          isLiveNow: item.snippet?.liveBroadcastContent === "live",
          language: item.snippet?.defaultAudioLanguage ?? item.snippet?.defaultLanguage ?? null,
          thumbnails: item.snippet?.thumbnails ?? null,
        });
      }
    } catch (e: any) {
      ctx.recordError({
        source: "youtube", raw_input: batch.join(","),
        source_export_file: "(batch)", classification_attempt: "youtube.videos.list",
        error_type: "fetch_failure_total",
        error_message: e?.message ?? "fetch_error",
        exception_traceback: e?.stack,
      });
    }
  }
  return out;
}

async function fetchChannels(ctx: IngestContext, channelIds: string[], apiKey: string): Promise<ChannelApiPayload[]> {
  const out: ChannelApiPayload[] = [];
  for (let i = 0; i < channelIds.length; i += 50) {
    const batch = channelIds.slice(i, i + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.searchParams.set("part", "snippet,statistics,contentDetails,topicDetails,brandingSettings,status");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);
    try {
      const resp = await fetch(url.toString());
      ctx.youtubeUnitsUsed++;
      if (!resp.ok) continue;
      const data = await resp.json() as any;
      for (const item of data.items ?? []) {
        out.push({
          channelId: item.id,
          title: item.snippet?.title ?? item.id,
          description: item.snippet?.description ?? null,
          customUrl: item.snippet?.customUrl ?? null,
          country: item.snippet?.country ?? null,
          thumbnail: item.snippet?.thumbnails?.default?.url ?? null,
          topicCategories: item.topicDetails?.topicCategories ?? [],
          subscriberCount: item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : null,
          videoCount: item.statistics?.videoCount ? Number(item.statistics.videoCount) : null,
        });
      }
    } catch { /* ignore; missing channels show as partial Instances */ }
  }
  return out;
}

function createVideoInstanceForGroup(
  ctx: IngestContext,
  g: { nativeId: string; canonical: string; bookmarks: RawBookmark[] },
  v: VideoApiPayload,
  channel: ChannelApiPayload | null
): void {
  let creatorAuthorityId: string | null = null;
  if (v.channelId) {
    creatorAuthorityId = findOrCreateCreatorAuthority(
      ctx.db, "youtube",
      channel?.title ?? v.channelTitle ?? v.channelId,
      v.channelId,
      {
        variants: channel?.customUrl ? [channel.customUrl] : [],
        external_ids: {
          youtube_channel_id: v.channelId,
          ...(channel?.customUrl ? { youtube_custom_url: channel.customUrl } : {}),
        },
        description: channel?.description ?? undefined,
      }
    );
    ctx.authoritiesTouched.add(creatorAuthorityId);
  }

  const instanceId = `inst_yt_${v.videoId}`;
  const workId = createWorkForInstance(ctx.db, v.title, v.description);

  const sourcePayload = {
    category_id: v.categoryId,
    tags: v.tags,
    topic_urls: v.topicCategories,
    duration: v.duration,
    view_count: v.viewCount,
    like_count: v.likeCount,
    was_livestream: v.wasLivestream,
    is_live_now: v.isLiveNow,
    language: v.language,
    thumbnails: v.thumbnails,
    channel_topics: channel?.topicCategories ?? [],
  };

  ctx.db.prepare(`
    INSERT INTO instances (
      id, source, kind, native_id, url_canonical,
      title, description, source_payload_json,
      creator_authority_id, subject_authority_ids_json,
      work_id, access_status, is_archived_url,
      ingest_status, partial_reason, fetched_at
    )
    VALUES (?, 'youtube', 'video', ?, ?, ?, ?, ?, ?, '[]', ?, 'live', 0, 'ok', NULL, ?)
  `).run(
    instanceId, v.videoId, g.canonical,
    v.title, v.description, JSON.stringify(sourcePayload),
    creatorAuthorityId, workId, Date.now()
  );

  ctx.markInstanceSeen("youtube", v.videoId);
  ctx.instancesCreated++;
  ctx.byStatus.ok++;

  // One Item per RawBookmark in the group
  for (const bm of g.bookmarks) {
    upsertItem(ctx, "youtube", instanceId, bm, g.canonical);
  }
}

function createChannelInstanceForGroup(
  ctx: IngestContext,
  g: { nativeId: string; canonical: string; bookmarks: RawBookmark[] },
  ch: ChannelApiPayload
): void {
  const creatorAuthorityId = findOrCreateCreatorAuthority(
    ctx.db, "youtube", ch.title, ch.channelId,
    {
      variants: ch.customUrl ? [ch.customUrl] : [],
      external_ids: { youtube_channel_id: ch.channelId, ...(ch.customUrl ? { youtube_custom_url: ch.customUrl } : {}) },
      description: ch.description ?? undefined,
    }
  );
  ctx.authoritiesTouched.add(creatorAuthorityId);

  const instanceId = `inst_ytch_${ch.channelId}`;
  const workId = createWorkForInstance(ctx.db, ch.title, ch.description);

  ctx.db.prepare(`
    INSERT INTO instances (
      id, source, kind, native_id, url_canonical,
      title, description, source_payload_json,
      creator_authority_id, subject_authority_ids_json,
      work_id, access_status, is_archived_url,
      ingest_status, partial_reason, fetched_at
    )
    VALUES (?, 'youtube', 'creator-page', ?, ?, ?, ?, ?, ?, '[]', ?, 'live', 0, 'ok', NULL, ?)
  `).run(
    instanceId, ch.channelId, g.canonical,
    ch.title, ch.description, JSON.stringify({ topic_urls: ch.topicCategories, subscriber_count: ch.subscriberCount }),
    creatorAuthorityId, workId, Date.now()
  );
  ctx.markInstanceSeen("youtube", ch.channelId);
  ctx.instancesCreated++;
  ctx.byStatus.ok++;
  for (const bm of g.bookmarks) {
    upsertItem(ctx, "youtube", instanceId, bm, g.canonical);
  }
}

function createPartialNoApiInstanceForGroup(
  ctx: IngestContext,
  g: { nativeId: string; canonical: string; bookmarks: RawBookmark[] },
  kind: Kind, reason: string = "missing_api_key"
): void {
  const instanceId = `inst_yt_${g.nativeId}`;
  // Title best-effort from any bookmark in the group that has one
  const titleHint = g.bookmarks.find((b) => b.title)?.title ?? null;
  const workId = createWorkForInstance(ctx.db, titleHint, null);
  ctx.db.prepare(`
    INSERT INTO instances (
      id, source, kind, native_id, url_canonical,
      title, description, source_payload_json,
      creator_authority_id, subject_authority_ids_json,
      work_id, access_status, is_archived_url,
      ingest_status, partial_reason, fetched_at
    )
    VALUES (?, 'youtube', ?, ?, ?, ?, NULL, NULL, NULL, '[]', ?, 'unknown', 0, 'partial', ?, ?)
  `).run(instanceId, kind, g.nativeId, g.canonical, titleHint, workId, reason, Date.now());
  ctx.markInstanceSeen("youtube", g.nativeId);
  ctx.instancesCreated++;
  ctx.byStatus.partial++;
  for (const bm of g.bookmarks) {
    upsertItem(ctx, "youtube", instanceId, bm, g.canonical);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Playlist fetcher (added 2026-05-20; was deferred in v0)
// ──────────────────────────────────────────────────────────────────────────

interface PlaylistApiPayload {
  playlistId: string;
  title: string;
  description: string | null;
  channelId: string | null;
  channelTitle: string | null;
  itemCount: number | null;
  publishedAt: string | null;
  thumbnails: any;
}

async function fetchPlaylists(ctx: IngestContext, playlistIds: string[], apiKey: string): Promise<PlaylistApiPayload[]> {
  const out: PlaylistApiPayload[] = [];
  for (let i = 0; i < playlistIds.length; i += 50) {
    const batch = playlistIds.slice(i, i + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/playlists");
    url.searchParams.set("part", "snippet,contentDetails,status");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);
    try {
      const resp = await fetch(url.toString());
      ctx.youtubeUnitsUsed++;
      if (!resp.ok) continue;
      const data = await resp.json() as any;
      for (const item of data.items ?? []) {
        out.push({
          playlistId: item.id,
          title: item.snippet?.title ?? "(untitled playlist)",
          description: item.snippet?.description ?? null,
          channelId: item.snippet?.channelId ?? null,
          channelTitle: item.snippet?.channelTitle ?? null,
          itemCount: item.contentDetails?.itemCount ?? null,
          publishedAt: item.snippet?.publishedAt ?? null,
          thumbnails: item.snippet?.thumbnails ?? null,
        });
      }
    } catch (e: any) {
      ctx.recordError({
        source: "youtube", raw_input: batch.join(","),
        source_export_file: "(batch)", classification_attempt: "youtube.playlists.list",
        error_type: "fetch_failure_total",
        error_message: e?.message ?? "fetch_error",
      });
    }
  }
  return out;
}

function createPlaylistInstanceForGroup(
  ctx: IngestContext,
  g: { nativeId: string; canonical: string; bookmarks: RawBookmark[] },
  p: PlaylistApiPayload,
  channel: ChannelApiPayload | null
): void {
  let creatorAuthorityId: string | null = null;
  if (p.channelId) {
    creatorAuthorityId = findOrCreateCreatorAuthority(
      ctx.db, "youtube",
      channel?.title ?? p.channelTitle ?? p.channelId,
      p.channelId,
      {
        variants: channel?.customUrl ? [channel.customUrl] : [],
        external_ids: {
          youtube_channel_id: p.channelId,
          ...(channel?.customUrl ? { youtube_custom_url: channel.customUrl } : {}),
        },
        description: channel?.description ?? undefined,
      }
    );
    ctx.authoritiesTouched.add(creatorAuthorityId);
  }

  const instanceId = `inst_yt_${p.playlistId}`;
  const workId = createWorkForInstance(ctx.db, p.title, p.description);

  const sourcePayload = {
    item_count: p.itemCount,
    published_at: p.publishedAt,
    thumbnails: p.thumbnails,
    channel_topics: channel?.topicCategories ?? [],
  };

  ctx.db.prepare(`
    INSERT INTO instances (
      id, source, kind, native_id, url_canonical,
      title, description, source_payload_json,
      creator_authority_id, subject_authority_ids_json,
      work_id, access_status, is_archived_url,
      ingest_status, partial_reason, fetched_at
    )
    VALUES (?, 'youtube', 'video-playlist', ?, ?, ?, ?, ?, ?, '[]', ?, 'live', 0, 'ok', NULL, ?)
  `).run(
    instanceId, p.playlistId, g.canonical,
    p.title, p.description, JSON.stringify(sourcePayload),
    creatorAuthorityId, workId, Date.now()
  );

  ctx.markInstanceSeen("youtube", p.playlistId);
  ctx.instancesCreated++;
  ctx.byStatus.ok++;
  for (const bm of g.bookmarks) {
    upsertItem(ctx, "youtube", instanceId, bm, g.canonical);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Channel-page resolver: local match → forHandle → forUsername → partial
// (added 2026-05-20; was deferred in v0)
// ──────────────────────────────────────────────────────────────────────────

async function fetchChannelByHandle(ctx: IngestContext, handle: string, apiKey: string): Promise<ChannelApiPayload | null> {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics,contentDetails,topicDetails,brandingSettings,status");
  // forHandle requires the leading @
  url.searchParams.set("forHandle", handle.startsWith("@") ? handle : `@${handle}`);
  url.searchParams.set("key", apiKey);
  try {
    const resp = await fetch(url.toString());
    ctx.youtubeUnitsUsed++;
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const item = data.items?.[0];
    if (!item) return null;
    return channelApiPayloadFromItem(item);
  } catch { return null; }
}

async function fetchChannelByUsername(ctx: IngestContext, username: string, apiKey: string): Promise<ChannelApiPayload | null> {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics,contentDetails,topicDetails,brandingSettings,status");
  url.searchParams.set("forUsername", username);
  url.searchParams.set("key", apiKey);
  try {
    const resp = await fetch(url.toString());
    ctx.youtubeUnitsUsed++;
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    const item = data.items?.[0];
    if (!item) return null;
    return channelApiPayloadFromItem(item);
  } catch { return null; }
}

function channelApiPayloadFromItem(item: any): ChannelApiPayload {
  return {
    channelId: item.id,
    title: item.snippet?.title ?? item.id,
    description: item.snippet?.description ?? null,
    customUrl: item.snippet?.customUrl ?? null,
    country: item.snippet?.country ?? null,
    thumbnail: item.snippet?.thumbnails?.default?.url ?? null,
    topicCategories: item.topicDetails?.topicCategories ?? [],
    subscriberCount: item.statistics?.subscriberCount ? Number(item.statistics.subscriberCount) : null,
    videoCount: item.statistics?.videoCount ? Number(item.statistics.videoCount) : null,
  };
}

// Extract the handle/username string from a channel-page group's nativeId or URL.
// Returns the bare string (no leading @). nativeId values from canonicalize:
//   "@parttimelarry" → "parttimelarry"
//   "parttimelarry"  → "parttimelarry"  (from /c/parttimelarry)
//   "Hak5Darren"     → "Hak5Darren"     (from /user/Hak5Darren)
function extractChannelHandle(nativeId: string): string {
  return nativeId.replace(/^@/, "");
}

// True if the nativeId came from a /@ handle URL (vs /c/ or /user/).
function isHandleNative(nativeId: string): boolean {
  return nativeId.startsWith("@");
}

// True if the canonical URL is a /user/ URL (legacy YouTube username).
function isUsernameUrl(canonical: string): boolean {
  return canonical.includes("/user/");
}

async function resolveChannelPageGroup(
  ctx: IngestContext,
  g: { nativeId: string; canonical: string; bookmarks: RawBookmark[] },
  channelById: Map<string, ChannelApiPayload>,
  apiKey: string | null
): Promise<void> {
  // Case 1: nativeId is already a channel ID (came from /channel/UCxxx URL).
  // The existing channelById map already has it (fetched in the main batch).
  if (!isHandleNative(g.nativeId) && /^UC[A-Za-z0-9_-]{20,}$/.test(g.nativeId)) {
    const ch = channelById.get(g.nativeId);
    if (ch) {
      createChannelInstanceForGroup(ctx, g, ch);
      return;
    }
    // Channel ID didn't return (no API or channel deleted)
    createPartialNoApiInstanceForGroup(ctx, g, "creator-page",
      apiKey ? "channel_not_returned_by_api" : "missing_api_key");
    return;
  }

  // Case 2: handle or custom URL. Try local match first (free, no API).
  const handle = extractChannelHandle(g.nativeId);
  const localMatch = findYoutubeAuthorityByHandle(ctx.db, handle);
  if (localMatch && localMatch.external_ids.youtube_channel_id) {
    const channelId = localMatch.external_ids.youtube_channel_id;
    // Check if we already have a creator-page Instance for this channel
    const existingInst = ctx.db.prepare(
      "SELECT id FROM instances WHERE source = 'youtube' AND native_id = ? AND kind = 'creator-page' LIMIT 1"
    ).get(channelId) as { id: string } | undefined;
    if (existingInst) {
      for (const bm of g.bookmarks) upsertItem(ctx, "youtube", existingInst.id, bm, g.canonical);
      return;
    }
    // Create a creator-page Instance using existing authority. We use the
    // authority's channel_id as nativeId so future resolution lands here.
    const fakeCh: ChannelApiPayload = {
      channelId,
      title: localMatch.preferred,
      description: null,
      customUrl: localMatch.external_ids.youtube_custom_url ?? null,
      country: null,
      thumbnail: null,
      topicCategories: [],
      subscriberCount: null,
      videoCount: null,
    };
    // Mark partial because we don't have full channel data — just the authority link.
    // Title and creator are correct, but stats/topics are missing.
    createChannelInstanceForGroupWithStatus(ctx, { ...g, nativeId: channelId }, fakeCh, "ok", null, "local_authority_match");
    return;
  }

  // Case 3: API resolution. Try forHandle first (modern @ URLs), then forUsername (legacy /user/).
  // Skip entirely if no API key.
  if (!apiKey) {
    createPartialNoApiInstanceForGroup(ctx, g, "creator-page", "missing_api_key");
    return;
  }

  let fetched: ChannelApiPayload | null = null;
  if (isHandleNative(g.nativeId) || g.canonical.includes("/c/")) {
    fetched = await fetchChannelByHandle(ctx, handle, apiKey);
  }
  if (!fetched && isUsernameUrl(g.canonical)) {
    fetched = await fetchChannelByUsername(ctx, handle, apiKey);
  }
  // Fallback: if the /c/<custom> form failed via handle, also try as username
  if (!fetched && g.canonical.includes("/c/")) {
    fetched = await fetchChannelByUsername(ctx, handle, apiKey);
  }

  if (fetched) {
    // Did the API return a channel we already have an Instance for?
    if (ctx.hasSeenInstance("youtube", fetched.channelId)) {
      const existingInst = ctx.db.prepare(
        "SELECT id FROM instances WHERE source = 'youtube' AND native_id = ? AND kind = 'creator-page' LIMIT 1"
      ).get(fetched.channelId) as { id: string } | undefined;
      if (existingInst) {
        for (const bm of g.bookmarks) upsertItem(ctx, "youtube", existingInst.id, bm, g.canonical);
        return;
      }
    }
    createChannelInstanceForGroup(ctx, { ...g, nativeId: fetched.channelId }, fetched);
    return;
  }

  // Resolution failed at every step.
  createPartialNoApiInstanceForGroup(ctx, g, "creator-page", "channel_handle_resolution_failed");
}

// Variant of createChannelInstanceForGroup that lets the caller specify status/reason
// and the resolution provenance (e.g., "local_authority_match", "api_for_handle").
// The provenance is recorded in source_payload.channel_resolution_path so audits can
// trace HOW each channel-page Instance was resolved, separate from its ok/partial state.
function createChannelInstanceForGroupWithStatus(
  ctx: IngestContext,
  g: { nativeId: string; canonical: string; bookmarks: RawBookmark[] },
  ch: ChannelApiPayload,
  status: "ok" | "partial",
  reason: string | null,
  resolutionPath: string
): void {
  const creatorAuthorityId = findOrCreateCreatorAuthority(
    ctx.db, "youtube", ch.title, ch.channelId,
    {
      variants: ch.customUrl ? [ch.customUrl] : [],
      external_ids: { youtube_channel_id: ch.channelId, ...(ch.customUrl ? { youtube_custom_url: ch.customUrl } : {}) },
      description: ch.description ?? undefined,
    }
  );
  ctx.authoritiesTouched.add(creatorAuthorityId);

  const instanceId = `inst_ytch_${ch.channelId}`;
  // Rewrite canonical to /channel/UC... form since we now know the channel ID
  const canonicalChannel = `https://www.youtube.com/channel/${ch.channelId}`;
  const workId = createWorkForInstance(ctx.db, ch.title, ch.description);

  const sourcePayload = {
    topic_urls: ch.topicCategories,
    subscriber_count: ch.subscriberCount,
    channel_resolution_path: resolutionPath,
    // When resolved via local-match we don't have full channel stats (description,
    // subscriberCount, videoCount); the Instance is structurally complete but
    // stats-light. has_full_channel_data flags that for any future enrichment pass.
    has_full_channel_data: resolutionPath !== "local_authority_match",
  };

  ctx.db.prepare(`
    INSERT INTO instances (
      id, source, kind, native_id, url_canonical,
      title, description, source_payload_json,
      creator_authority_id, subject_authority_ids_json,
      work_id, access_status, is_archived_url,
      ingest_status, partial_reason, fetched_at
    )
    VALUES (?, 'youtube', 'creator-page', ?, ?, ?, ?, ?, ?, '[]', ?, 'live', 0, ?, ?, ?)
  `).run(
    instanceId, ch.channelId, canonicalChannel,
    ch.title, ch.description, JSON.stringify(sourcePayload),
    creatorAuthorityId, workId, status, reason, Date.now()
  );
  ctx.markInstanceSeen("youtube", ch.channelId);
  ctx.instancesCreated++;
  ctx.byStatus[status]++;
  for (const bm of g.bookmarks) {
    upsertItem(ctx, "youtube", instanceId, bm, g.canonical);
  }
}
