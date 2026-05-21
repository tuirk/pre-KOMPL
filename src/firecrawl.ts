// Firecrawl /v2/scrape client. Used as a rescue path when og-peek fails.
// Sends a single URL, executes JS, follows redirects, returns extracted metadata.
//
// Costs 1 credit per call. Free tier is 500 credits/month. Budget tracking
// is the caller's responsibility — see config.ts (FIRECRAWL_BUDGET) and
// IngestContext.firecrawlCreditsUsed.
//
// API reference: https://docs.firecrawl.dev/api-reference/endpoint/scrape
// Verified against v2 docs on 2026-05-20. V1 was deprecated April 2025.
//
// Response shape:
//   { success: true, data: { markdown, metadata: { title, description, language,
//     sourceURL, url, keywords, statusCode, contentType, ...og:* passthrough } } }
//
// Open Graph and Twitter Card meta keys pass through as additional metadata
// fields (ogTitle, ogDescription, ogImage, ogSiteName, twitterCard, etc.)
// alongside the documented core fields.

const FC_API_URL = "https://api.firecrawl.dev/v2/scrape";

// Firecrawl's documented default timeout is 60s (page render can be slow on
// JS-heavy sites). We use 45s as a middle ground — long enough for most pages,
// short enough not to stall the catalog for one slow URL.
const FC_TIMEOUT_MS = 45_000;

export interface FirecrawlResult {
  success: boolean;
  failure_reason?: string; // populated when success === false

  title: string | null;
  description: string | null;
  image_url: string | null;
  author: string | null;
  site_name: string | null;
  language: string | null;
  published_time: string | null; // ISO 8601 if available
  status_code: number | null;    // upstream HTTP status as seen by Firecrawl

  final_url: string;
}

export async function fcScrape(url: string, apiKey: string): Promise<FirecrawlResult> {
  const empty = (reason: string): FirecrawlResult => ({
    success: false,
    failure_reason: reason,
    title: null, description: null, image_url: null,
    author: null, site_name: null, language: null,
    published_time: null, status_code: null,
    final_url: url,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FC_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(FC_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        // We always need markdown to be requested so the engine fully renders;
        // metadata is returned alongside regardless of which formats are listed.
        // We discard the markdown body — pre-kompl stores only metadata.
        formats: ["markdown"],
        onlyMainContent: true,
        // blockAds: true and proxy: "auto" are defaults; leaving them off the
        // request body so future Firecrawl default changes propagate to us.
      }),
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === "AbortError") return empty("timeout");
    return empty(e?.message ?? "fetch_error");
  }
  clearTimeout(timer);

  if (!resp.ok) {
    // 402 = out of credits, 401 = bad API key, 429 = rate limited, 4xx/5xx others
    return empty(`http_${resp.status}`);
  }

  let data: any;
  try { data = await resp.json(); } catch { return empty("invalid_json"); }

  if (!data?.success || !data?.data) {
    return empty(data?.error ?? "fc_returned_unsuccess");
  }

  const m = data.data.metadata ?? {};
  // Title cascade: og:title > standard title. (Firecrawl passes both through
  // when present; og:title is usually richer for article pages.)
  const title = pickString(m.ogTitle, m.title, m["og:title"]);
  // Description cascade: og:description > meta description.
  const description = pickString(m.ogDescription, m.description, m["og:description"]);
  // Image: og:image only (no html-side fallback worth pursuing).
  const image_url = pickString(m.ogImage, m["og:image"]);
  // Author: meta author > article:author > schema.org author.
  const author = pickString(m.author, m.articleAuthor, m["article:author"], m["author"]);
  // Site name: og:site_name.
  const site_name = pickString(m.ogSiteName, m["og:site_name"]);
  // Language: documented core field; falls back to html lang via og:locale.
  const language = pickString(m.language, m.ogLocale, m["og:locale"]);
  // Published time: article:published_time is the canonical spelling.
  const published_time = pickString(
    m.articlePublishedTime, m["article:published_time"],
    m.publishedTime, m.datePublished
  );

  return {
    success: true,
    title,
    description,
    image_url,
    author,
    site_name,
    language,
    published_time,
    status_code: typeof m.statusCode === "number" ? m.statusCode : null,
    final_url: pickString(m.sourceURL, m.url) ?? url,
  };
}

function pickString(...candidates: Array<unknown>): string | null {
  for (const c of candidates) {
    if (typeof c === "string") {
      const trimmed = c.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}
