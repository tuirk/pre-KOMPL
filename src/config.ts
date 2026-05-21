// Config: env vars + paths. No hardcoded secrets.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

export interface Config {
  dbPath: string;
  logsDir: string;
  youtubeApiKey: string | null;
  githubToken: string | null;
  firecrawlApiKey: string | null;
  firecrawlEnabled: boolean;
  firecrawlBudget: number; // max credits per run; default 500 (free-tier monthly cap)
}

export function loadConfig(): Config {
  const root = process.env.PRE_KOMPL_HOME ?? join(homedir(), ".pre-kompl");
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  const logsDir = join(root, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

  const budgetRaw = process.env.FIRECRAWL_BUDGET;
  const firecrawlBudget = budgetRaw ? Math.max(0, parseInt(budgetRaw, 10) || 0) : 500;

  return {
    dbPath: process.env.PRE_KOMPL_DB ?? join(root, "catalog.db"),
    logsDir,
    youtubeApiKey: process.env.YOUTUBE_API_KEY ?? null,
    githubToken: process.env.GITHUB_TOKEN ?? null,
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? null,
    firecrawlEnabled: !!process.env.FIRECRAWL_API_KEY,
    firecrawlBudget,
  };
}

// Canonicalization-rules version. Bump when canonicalize.ts rules change.
// Bumping requires a migration that recomputes Web native_ids.
//
// v1 (initial): basic utm_*, ref/gclid/fbclid/mc_*/_ga/_gl/igshid/hsCtaTracking/mkt_tok/yclid/si
// v2 (2026-05-20):
//   - YouTube /live/<id> recognized as video
//   - YouTube creator-page URLs strip /videos /shorts /about /community /featured tabs
//   - Tracking-param stripping is now prefix-based (utm_*, ranEAID/MID/SiteID) plus
//     expanded explicit list (bxid, cndid, esrc, mbid, hsenc, hsmi, mc_eid, _hsenc, etc.)
export const CANONICALIZATION_RULES_VERSION = 2;
