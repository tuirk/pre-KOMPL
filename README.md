# pre-kompl

Lightweight catalog for thousands of saved bookmarks. Sits beneath Kompl.

v0.1 MVP — CLI ingest of a folder of bookmark exports / notes files into a local SQLite catalog.

## Install

Needs Node 22.5+ (uses built-in `node:sqlite`, no native compilation).

```bash
npm install
```

No build step. `tsx` runs TypeScript directly.

On Node 22.5–22.16, `node:sqlite` is gated behind a flag. If you see `ERR_UNKNOWN_BUILTIN_MODULE`, run every command with `NODE_OPTIONS="--experimental-sqlite"`:

```bash
NODE_OPTIONS="--experimental-sqlite" npx tsx --no-warnings src/cli.ts ingest /path/to/folder
```

On Node 22.17+ the flag is no longer required.

## Configure

```bash
export YOUTUBE_API_KEY="..."     # optional — without it, YouTube Instances ingest as partial / missing_api_key
export GITHUB_TOKEN="..."         # optional — without it, GitHub Instances ingest as partial / missing_api_key
export FIRECRAWL_API_KEY="..."    # optional — enables the JS-rendered rescue cascade for blocked/failed web URLs
export FIRECRAWL_BUDGET="500"     # optional — max Firecrawl credits per run (default 500 = free-tier monthly cap)
```

Storage defaults to `~/.pre-kompl/catalog.db`. Override with `PRE_KOMPL_DB` and/or `PRE_KOMPL_HOME`.

## Run

```bash
# Ingest a folder. Pre-kompl auto-detects what each file is.
# Supports: Netscape browser-bookmarks HTML, Twitter JSON exports (7 shapes), notes files (any text with URLs)
npx tsx --no-warnings src/cli.ts ingest /path/to/your/exports/

# Check what's in the catalog
npx tsx --no-warnings src/cli.ts status

# See what failed
npx tsx --no-warnings src/cli.ts errors

# See what ingested but is incomplete (and why)
npx tsx --no-warnings src/cli.ts partials

# Re-apply pure-logic rules to existing rows (no network, no credits)
npx tsx --no-warnings src/cli.ts reclassify
```

`npm run ingest -- /path/to/folder` works too, as does `npm run status` etc.

### When to re-ingest vs. reclassify

Ingest dedups on `(source, native_id)` — re-running ingest on the same bookmarks file is a no-op for Instances already in the catalog (no network calls, no row updates). That's a deliberate optimization so you don't burn API credits re-fetching the same 365 URLs. The side effect: if pre-kompl ships a logic-only fix (a tightened dead-link heuristic, a sharpened brand-default detector, a corrected status mapping), those rules need to be re-applied to existing rows.

| Kind of upstream change | Command to apply it |
| --- | --- |
| Pure-logic fix (dead-link, brand-default, status-semantics, legacy migration) | `pre-kompl reclassify` — ~50ms, deterministic, no credits |
| Anything that needs re-fetching (new YouTube fields, Firecrawl pipeline improvement, new external API) | Delete `~/.pre-kompl/catalog.db` and re-run `pre-kompl ingest` |
| Canonicalization-rules version bumped | DB will refuse to ingest until you wipe (a migration tool is the longer-term answer) |

The changelog you receive with each pre-kompl update will tell you which one.

`reclassify` is idempotent: running it against an already-current DB prints `Nothing to reclassify — every existing row already matches current rules.`

## What the four pipelines do

| Source  | API           | Without key                                | Dedup composite                              |
| ------- | ------------- | ------------------------------------------ | -------------------------------------------- |
| YouTube | Data API v3   | Instances saved as `partial / missing_api_key` | (instance_id, url_as_saved, save_date)       |
| GitHub  | REST v3       | Instances saved as `partial / missing_api_key` | (instance_id, url_as_saved, save_date)       |
| Twitter | none          | Twitter never uses an API                   | (instance_id, url_as_saved)                  |
| Web     | og-peek + Firecrawl rescue | og-peek tries directly; on `blocked` / `failed` / `peek_exception` / `no_og_tags` / `brand_default_title`, Firecrawl `/v2/scrape` is retried (1 credit/call, JS-rendered). Dead-link signals (HTTP 4xx/5xx, soft-404 title patterns) demote the result to `partial / dead_link`. If Firecrawl can't help either, the original partial reason is preserved. | (instance_id, url_as_saved, save_date, bookmark_folder_path) |

Tweet URLs that land in non-Twitter files (chrome bookmark, notes file) get synthesized into the Twitter pipeline as URL-only entries; they ingest as `partial / empty_text`. If the same tweet is *also* in a Twitter JSON export, the real export populates the Instance first and the synthesized version dedups (rich data wins).

## Spec

Full spec in [`pre-kompl-spec/`](./pre-kompl-spec/) — 15 files, ~3800 lines covering Work/Instance/Item model, authorities, dedup composites, never-drop principle, canonicalization-versioning, the works.

## Vendor-copied files

* `src/parsers/twitter-parser.ts` — copied verbatim from `kompl/app/src/lib/twitter-parser.ts` on 2026-05-20. Includes `scrapeTweetTextDom` (used by Kompl's bookmarklet; pre-kompl doesn't ship the bookmarklet yet but mirrors the file 1:1).

Everything else is fresh pre-kompl code. There is no `metadata-peek.ts` in Kompl — `src/parsers/web-peek.ts` is original to pre-kompl.

## Canonicalization-rules version

`CANONICALIZATION_RULES_VERSION` in `src/config.ts`. Bumping requires a migration over Web Instance `native_id`s (which are the canonical URL — versioned coupling). DB refuses to ingest if the version on disk doesn't match the code's version.

## Test fixtures

`test-fixtures/bookmarks-may-2026/` has:
- `twitter-bookmarks.json` — real export from bestie (12 tweets, includes long Note Tweet)
- `chrome-bookmarks.html` — synthetic browser export covering folders, sub-resource URLs, cross-source dedup cases
- `reading-list.md` — notes file mixing markdown links and prose URLs, includes an intentional dupe with chrome
- `screenshot.png` — binary, should be skipped
- `notes-no-urls.txt` — text with no URLs, should be skipped

Run `npx tsx --no-warnings src/cli.ts ingest test-fixtures/bookmarks-may-2026/` to see the full pipeline.
