// URL classifier — first decision in the pipeline.
// Given a raw URL, return which source pipeline handles it.
// Pure function. No network calls (shortener resolution happens inside the web pipeline).
import type { Source } from "./types.js";

export type Classification =
  | { kind: "routed"; source: Source }
  | { kind: "gist"; reason: "out_of_scope_for_v0" } // GitHub gists are out of scope
  | { kind: "shortener"; pattern: string } // t.co etc — needs HEAD resolution
  | { kind: "unsupported"; reason: string }; // mailto:, javascript:, file://, etc

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const TW_HOSTS = new Set([
  "twitter.com",
  "www.twitter.com",
  "x.com",
  "www.x.com",
  "mobile.twitter.com",
]);
const SHORTENERS = new Set([
  "t.co",
  "bit.ly",
  "buff.ly",
  "ow.ly",
  "tinyurl.com",
  "is.gd",
  "goo.gl",
]);

export function classifyUrl(url: string): Classification {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "unsupported", reason: "malformed_url" };
  }

  const proto = parsed.protocol;
  if (proto !== "http:" && proto !== "https:") {
    return { kind: "unsupported", reason: `protocol_${proto.replace(":", "")}` };
  }

  const host = parsed.hostname.toLowerCase();

  if (YT_HOSTS.has(host)) return { kind: "routed", source: "youtube" };

  if (host === "github.com" || host === "www.github.com") {
    return { kind: "routed", source: "github" };
  }
  if (host === "gist.github.com") return { kind: "gist", reason: "out_of_scope_for_v0" };

  if (TW_HOSTS.has(host)) return { kind: "routed", source: "twitter" };

  if (SHORTENERS.has(host)) return { kind: "shortener", pattern: host };

  return { kind: "routed", source: "web" };
}
