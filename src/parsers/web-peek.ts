// og-peek: cheap HEAD-ish GET that reads only the <head> of a page to extract OG/JSON-LD metadata.
// 64 KiB body cap, 2s timeout, encoding detection (HTML meta charset → HTTP charset → UTF-8 default).
//
// NOT vendor-copied from Kompl — Kompl doesn't have this file. Original implementation per spec
// at /pre-kompl-spec/sources/misc.md.

import { load as cheerioLoad } from "cheerio";

export interface PeekResult {
  status: "ok" | "blocked" | "no_og_tags" | "failed" | "not_html";
  http_code?: number;
  reason?: string;
  // Extracted metadata (best-effort; nulls when unavailable)
  title: string | null;
  title_source: "og_tag" | "json_ld" | "html_title" | "url_fallback" | null;
  description: string | null;
  description_source: "og_tag" | "json_ld" | "meta_description" | null;
  image_url: string | null;
  favicon_url: string | null;
  author: string | null;
  site_name: string | null;
  language: string | null;
  og_type: string | null;
  json_ld_types: string[]; // ["Article", "ScholarlyArticle", ...] when present
  // Provenance
  final_url: string;  // after redirects
  byte_count: number; // how much of the page we actually read (<= 64 KiB)
}

const TIMEOUT_MS = 2000;
const MAX_BYTES = 64 * 1024;

const BRAND_DEFAULT_TITLES = new Set([
  "Notion",
  "Google Docs",
  "Loading...",
  "Just a moment...",
  "Access denied",
  "403 Forbidden",
  "Error",
  "Untitled",
  "Sign in - Google Accounts",
  "Discord",
  "LinkedIn",
  "Twitter",
  "X",
  "Atlassian",
]);

// Generic suffix words that, when paired with the brand name, suggest a
// brand-default landing-page title rather than a content-specific title.
// E.g., "VirusTotal - Home", "ushby.org | Sign in", "Acme: Dashboard".
const BRAND_SUFFIX_RX = /^[-—–|:]\s*(home|login|sign\s*in|sign\s*up|welcome|index|main|app|dashboard|page|landing)\s*$/i;

export function isBrandDefaultTitle(title: string | null, url: string): boolean {
  if (!title) return false;
  const t = title.trim();
  if (!t) return false;

  let host: string, hostBrand: string;
  let pathSegments: string[];
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "");
    hostBrand = host.split(".")[0];
    pathSegments = u.pathname.split("/").filter(Boolean);
  } catch { return false; }

  // Only flag for URLs deep enough to expect content-specific titles.
  // - 2+ path segments → article/product/doc URL
  // - 1-segment URL whose segment contains a hyphen → article slug pattern
  //   (e.g., /chaplin-x-advanced-trading-bot-builder, NOT /about or /pricing)
  const isContentPath =
    pathSegments.length >= 2 ||
    (pathSegments.length === 1 && pathSegments[0].includes("-"));
  if (!isContentPath) return false;

  // Hardcoded brand-default titles (auth walls, generic error pages, etc.)
  if (BRAND_DEFAULT_TITLES.has(t)) return true;

  const tLower = t.toLowerCase();
  const brandLower = hostBrand.toLowerCase();
  const hostLower = host.toLowerCase();

  // Title is exactly the bare brand (e.g., "Velo", "Cybersole")
  if (tLower === brandLower) return true;
  // Title is exactly the host with TLD (e.g., "ushby.org", "chaplin.app")
  if (tLower === hostLower) return true;

  // "Brand <generic suffix>" pattern (e.g., "VirusTotal - Home", "Acme | Login").
  // Check against both bare brand and brand-with-TLD as possible prefixes.
  for (const stem of [brandLower, hostLower]) {
    if (tLower.startsWith(stem) && t.length <= 40) {
      const suffix = t.slice(stem.length).trim();
      if (BRAND_SUFFIX_RX.test(suffix)) return true;
    }
  }
  return false;
}

export async function ogPeek(url: string): Promise<PeekResult> {
  const empty = (status: PeekResult["status"], reason: string, http_code?: number): PeekResult => ({
    status, reason, http_code,
    title: null, title_source: null,
    description: null, description_source: null,
    image_url: null, favicon_url: null,
    author: null, site_name: null, language: null, og_type: null,
    json_ld_types: [],
    final_url: url, byte_count: 0,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pre-kompl/0.1)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === "AbortError") return empty("failed", "timeout");
    return empty("failed", e?.message ?? "fetch_error");
  }
  clearTimeout(timer);

  const finalUrl = resp.url || url;

  if (!resp.ok) {
    const r = empty("blocked", `http_${resp.status}`, resp.status);
    r.final_url = finalUrl;
    return r;
  }

  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    const r = empty("not_html", contentType);
    r.final_url = finalUrl;
    return r;
  }

  // Stream up to MAX_BYTES
  const reader = resp.body?.getReader();
  if (!reader) {
    const r = empty("failed", "no_body");
    r.final_url = finalUrl;
    return r;
  }

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (bytesRead < MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } catch (e: any) {
    // ignore read errors after partial; we'll parse what we have
  } finally {
    try { await reader.cancel(); } catch { /* eslint */ }
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  const enc = detectEncoding(buf, contentType);
  let html: string;
  try {
    html = buf.toString(enc as BufferEncoding);
  } catch {
    html = buf.toString("utf-8");
  }

  // Strip UTF-8 BOM if present
  if (html.charCodeAt(0) === 0xfeff) html = html.slice(1);

  const $ = cheerioLoad(html);

  // Title cascade
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() || null;
  const htmlTitle = $("title").first().text().trim() || null;
  let title = ogTitle ?? htmlTitle;
  let titleSource: PeekResult["title_source"] = ogTitle ? "og_tag" : htmlTitle ? "html_title" : null;

  // Description cascade
  const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() || null;
  const metaDesc = $('meta[name="description"]').attr("content")?.trim() || null;
  let description = ogDesc ?? metaDesc;
  let descriptionSource: PeekResult["description_source"] = ogDesc ? "og_tag" : metaDesc ? "meta_description" : null;

  // Other OG / meta
  const image = $('meta[property="og:image"]').attr("content")?.trim() || null;
  const siteName = $('meta[property="og:site_name"]').attr("content")?.trim() || null;
  const author = ($('meta[name="author"]').attr("content")
    || $('meta[property="article:author"]').attr("content")
    || null)?.trim() || null;
  const ogType = $('meta[property="og:type"]').attr("content")?.trim() || null;
  const language = ($("html").attr("lang") || null)?.trim() || null;
  const favicon = ($('link[rel="icon"]').attr("href")
    || $('link[rel="shortcut icon"]').attr("href")
    || null);

  // JSON-LD types and fields (best-effort)
  const jsonLdTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text();
    if (!txt) return;
    try {
      const json = JSON.parse(txt);
      collectJsonLdTypes(json, jsonLdTypes);
      // Promote JSON-LD title/description if og missed
      const lift = extractFromJsonLd(json);
      if (!title && lift.title) { title = lift.title; titleSource = "json_ld"; }
      if (!description && lift.description) { description = lift.description; descriptionSource = "json_ld"; }
    } catch { /* malformed JSON-LD, skip */ }
  });

  // URL fallback for title
  if (!title) {
    title = finalUrl;
    titleSource = "url_fallback";
  }

  // Did we get anything useful?
  const hasAnyOg = !!(ogTitle || ogDesc || image || ogType);
  const hasAnyHtml = !!(htmlTitle || metaDesc);
  const status = hasAnyOg || hasAnyHtml || jsonLdTypes.length > 0 ? "ok" : "no_og_tags";

  return {
    status,
    title, title_source: titleSource,
    description, description_source: descriptionSource,
    image_url: image,
    favicon_url: favicon || null,
    author,
    site_name: siteName,
    language,
    og_type: ogType,
    json_ld_types: jsonLdTypes,
    final_url: finalUrl,
    byte_count: bytesRead,
  };
}

function detectEncoding(buf: Buffer, contentType: string): string {
  // Step 1: HTML meta charset (scan first 4 KiB to be safe; tolerate non-ASCII bytes)
  const head = buf.subarray(0, Math.min(4096, buf.length)).toString("latin1");
  const m1 = head.match(/<meta[^>]+charset\s*=\s*["']?([^"'>\s;]+)/i);
  if (m1) return normalizeCharset(m1[1]);

  // Step 2: HTTP Content-Type charset
  const m2 = contentType.match(/charset\s*=\s*([^\s;]+)/i);
  if (m2) return normalizeCharset(m2[1]);

  // Step 3: UTF-8 default
  return "utf-8";
}

function normalizeCharset(c: string): string {
  const lc = c.toLowerCase().trim().replace(/^["']|["']$/g, "");
  if (lc === "utf8" || lc === "utf-8") return "utf-8";
  if (lc === "iso-8859-1" || lc === "latin-1" || lc === "latin1") return "latin1";
  return lc;
}

function collectJsonLdTypes(node: any, out: string[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLdTypes(n, out);
    return;
  }
  if (typeof node !== "object") return;
  const t = node["@type"];
  if (typeof t === "string") out.push(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.push(x);
  // recurse into @graph and nested objects
  if (Array.isArray(node["@graph"])) collectJsonLdTypes(node["@graph"], out);
}

function extractFromJsonLd(node: any): { title: string | null; description: string | null } {
  if (!node) return { title: null, description: null };
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = extractFromJsonLd(n);
      if (r.title || r.description) return r;
    }
    return { title: null, description: null };
  }
  if (typeof node !== "object") return { title: null, description: null };
  if (Array.isArray(node["@graph"])) return extractFromJsonLd(node["@graph"]);
  return {
    title: (node.headline ?? node.name ?? null),
    description: (node.description ?? null),
  };
}
