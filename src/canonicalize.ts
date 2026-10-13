// URL canonicalization. v1 rules — bump CANONICALIZATION_RULES_VERSION in config.ts
// before changing these.
import type { Source } from "./types.js";

// Tracking params stripped from web URLs.
// Two-pronged: (1) prefix-match for utm_* and the ranEAID/MID/SiteID affiliate family,
// (2) explicit list for everything else. The set is intentionally aggressive — these are
// all known tracking params that don't affect what page you're looking at.
const TRACKING_PREFIXES = ["utm_", "raneaid", "ranmid", "ransiteid"];

const TRACKING_PARAMS_EXACT = new Set([
  // Generic
  "ref", "ref_", "ref_url", "ref_src", "refsrc", "referrer",
  // Click IDs
  "fbclid", "gclid", "dclid", "yclid", "msclkid", "wbraid", "gbraid", "twclid", "li_fat_id",
  // Mailchimp / generic email
  "mc_cid", "mc_eid", "mkt_tok",
  // Google Analytics
  "_ga", "_gl",
  // HubSpot
  "_hsenc", "_hsmi", "hsctatracking",
  // Social / publisher
  "igshid", "igsh", "si", // si: YouTube share-id (also Wired-style some pubs)
  // Condé Nast (Wired, New Yorker, GQ, Vogue, etc.)
  "bxid", "cndid", "esrc", "mbid",
  // Other publishers
  "share", "share_id", "shareid",
  // Marketing automation
  "trk", "trkcampaign", "trkcontact", "_branch_match_id", "_branch_referrer",
  // Email client
  "vero_id", "vero_conv",
]);

function isTrackingParam(name: string): boolean {
  const lc = name.toLowerCase();
  for (const p of TRACKING_PREFIXES) if (lc.startsWith(p)) return true;
  return TRACKING_PARAMS_EXACT.has(lc);
}

// ──────────── YouTube ────────────

export function canonicalizeYoutube(url: string): { canonical: string; nativeId: string; kind: "video" | "video-playlist" | "creator-page" } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = path.slice(1).split("/")[0];
    if (!id) return null;
    return { canonical: `https://www.youtube.com/watch?v=${id}`, nativeId: id, kind: "video" };
  }
  // /watch?v=<id>
  const v = parsed.searchParams.get("v");
  if (path === "/watch" && v) {
    return { canonical: `https://www.youtube.com/watch?v=${v}`, nativeId: v, kind: "video" };
  }
  // /shorts/<id>
  if (path.startsWith("/shorts/")) {
    const id = path.split("/")[2];
    if (!id) return null;
    return { canonical: `https://www.youtube.com/watch?v=${id}`, nativeId: id, kind: "video" };
  }
  // /embed/<id>
  if (path.startsWith("/embed/")) {
    const id = path.split("/")[2];
    if (!id) return null;
    return { canonical: `https://www.youtube.com/watch?v=${id}`, nativeId: id, kind: "video" };
  }
  // /live/<id> — livestream archive URL; resolves to a regular video
  if (path.startsWith("/live/")) {
    const id = path.split("/")[2];
    if (!id) return null;
    return { canonical: `https://www.youtube.com/watch?v=${id}`, nativeId: id, kind: "video" };
  }
  // /playlist?list=<id>
  if (path === "/playlist") {
    const list = parsed.searchParams.get("list");
    if (!list) return null;
    return { canonical: `https://www.youtube.com/playlist?list=${list}`, nativeId: list, kind: "video-playlist" };
  }
  // /channel/<UC...>
  if (path.startsWith("/channel/")) {
    const id = path.split("/")[2];
    if (!id) return null;
    return { canonical: `https://www.youtube.com/channel/${id}`, nativeId: id, kind: "creator-page" };
  }
  // /@<handle>[/<tab>] — strip tab suffixes (/videos, /shorts, /about, /community, /playlists, /featured)
  if (path.startsWith("/@")) {
    const handle = path.slice(2).split("/")[0];
    if (!handle) return null;
    return { canonical: `https://www.youtube.com/@${handle}`, nativeId: `@${handle}`, kind: "creator-page" };
  }
  // /c/<custom>[/<tab>] or /user/<old>[/<tab>] — strip tab suffix from both
  if (path.startsWith("/c/") || path.startsWith("/user/")) {
    const segs = path.split("/").filter(Boolean);
    if (segs.length < 2) return null;
    const prefix = segs[0]; // "c" or "user"
    const seg = segs[1];
    return { canonical: `https://www.youtube.com/${prefix}/${seg}`, nativeId: seg, kind: "creator-page" };
  }
  return null;
}

// ──────────── GitHub ────────────

export function canonicalizeGithub(url: string): { canonical: string; nativeId: string; kind: "github-repo" | "github-creator-page" } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const segs = parsed.pathname.split("/").filter(Boolean);
  if (segs.length === 0) return null;
  const owner = segs[0];
  if (segs.length === 1) {
    return { canonical: `https://github.com/${owner}`, nativeId: owner, kind: "github-creator-page" };
  }
  const repo = segs[1];
  // Strip sub-resources (tree, blob, issues, pull, releases, wiki, actions, etc).
  return { canonical: `https://github.com/${owner}/${repo}`, nativeId: `${owner}/${repo}`, kind: "github-repo" };
}

// ──────────── Twitter / X ────────────

export function canonicalizeTwitter(url: string): { canonical: string; nativeId: string; kind: "tweet" } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const segs = parsed.pathname.split("/").filter(Boolean);
  // /<handle>/status/<id>
  if (segs.length >= 3 && segs[1] === "status") {
    const handle = segs[0];
    const id = segs[2].split("?")[0];
    if (!/^\d+$/.test(id)) return null;
    return { canonical: `https://x.com/${handle}/status/${id}`, nativeId: id, kind: "tweet" };
  }
  return null;
}

// ──────────── Web ────────────

export function canonicalizeWeb(url: string): { canonical: string; nativeId: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }

  // Lowercase host
  let host = parsed.hostname.toLowerCase();
  // Strip default port
  let port = parsed.port;
  if ((parsed.protocol === "https:" && port === "443") || (parsed.protocol === "http:" && port === "80")) {
    port = "";
  }

  // Strip tracking params, sort the rest
  const remainingParams: [string, string][] = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    if (!isTrackingParam(k)) remainingParams.push([k, v]);
  }
  remainingParams.sort(([a], [b]) => a.localeCompare(b));

  // Strip trailing slash from path unless path is "/"
  let path = parsed.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // Build canonical
  const query = remainingParams.length === 0
    ? ""
    : "?" + remainingParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

  const portPart = port ? `:${port}` : "";
  const canonical = `${parsed.protocol}//${host}${portPart}${path}${query}`;

  // Web nativeId IS the canonical URL (per spec; this is the versioned coupling).
  return { canonical, nativeId: canonical };
}

// ──────────── Dispatcher ────────────

export function canonicalizeForSource(source: Source, url: string):
  | { canonical: string; nativeId: string; kind: string }
  | null {
  switch (source) {
    case "youtube": return canonicalizeYoutube(url);
    case "github":  return canonicalizeGithub(url);
    case "twitter": return canonicalizeTwitter(url);
    case "web":     {
      const r = canonicalizeWeb(url);
      return r ? { ...r, kind: "other" } : null;
    }
  }
}
