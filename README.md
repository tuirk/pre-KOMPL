# pre-kompl

Lightweight catalog for thousands of saved bookmarks. Sits beneath Kompl.

v0.1 MVP — CLI ingest of a folder of bookmark exports / notes files into a local SQLite catalog.

Ships with an [agent skill](#agent-skill) at [`skills/pre-kompl-search/`](./skills/pre-kompl-search/) so you can ask an LLM agent things like *"what do I have on agent memory?"* or *"find my saved trading repos"* and have it query the catalog correctly.

## Install

Needs Node 22+. Uses `better-sqlite3` (native, FTS5 enabled). Prebuilt binaries ship for Windows/macOS/Linux on common Node versions — no C compiler required for the supported platforms.

```bash
npm install
```

No build step. `tsx` runs TypeScript directly.

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

### Search

```bash
# Free-text search across title, description, folder paths, creator names, URLs.
# BM25-ranked, prefix-matched (memory matches memgpt, memories, agentmemory),
# porter-stemmed for English. Stopwords (the/for/with) dropped automatically.
npx tsx --no-warnings src/cli.ts search "agent memory"

# Narrow by facet
npx tsx --no-warnings src/cli.ts search "rag" --source github
npx tsx --no-warnings src/cli.ts search "" --folder "Bookmarks|Cyber DYOR|A.I."
npx tsx --no-warnings src/cli.ts search "memory" --creator vectorize
npx tsx --no-warnings src/cli.ts search "" --topic ai-memory --source github
npx tsx --no-warnings src/cli.ts search "trading" --kind video --limit 50

# Dead-link cleanup (default --status ok hides partials; broaden to see them)
npx tsx --no-warnings src/cli.ts search "" --partial dead_link --status all

# JSON envelope (items + facets + relaxation flag) for programmatic use
npx tsx --no-warnings src/cli.ts search "agents" --json
```

Flags: `--source`, `--kind`, `--folder`, `--creator`, `--topic`, `--status` (default `ok`), `--partial`, `--limit` (default 20, cap 100), `--json`.

Zero-result queries auto-relax by dropping the rightmost token and retrying; if still zero with 2+ tokens, retry once with OR across tokens. Empty query is allowed only when at least one filter is set — otherwise it would dump the whole catalog.

### SQL escape hatch

```bash
# Read-only SELECT (pipe-separated output; works on Windows without sqlite3 CLI)
npx tsx --no-warnings src/cli.ts sql "SELECT bookmark_folder_path, COUNT(*) c FROM items GROUP BY 1 ORDER BY c DESC LIMIT 5"
npx tsx --no-warnings src/cli.ts sql "SELECT title, source FROM instances WHERE ingest_status='ok' LIMIT 10" --json
```

### When to re-ingest vs. reclassify

Ingest dedups on `(source, native_id)` — re-running ingest on the same bookmarks file is a no-op for Instances already in the catalog (no network calls, no row updates). That's a deliberate optimization so you don't burn API credits re-fetching the same 365 URLs. The side effect: if pre-kompl ships a logic-only fix (a tightened dead-link heuristic, a sharpened brand-default detector, a corrected status mapping), those rules need to be re-applied to existing rows.

| Kind of upstream change | Command to apply it |
| --- | --- |
| Pure-logic fix (dead-link, brand-default, status-semantics, legacy migration) | `pre-kompl reclassify` — ~50ms, deterministic, no credits |
| Anything that needs re-fetching (new YouTube fields, Firecrawl pipeline improvement, new external API) | Delete `~/.pre-kompl/catalog.db` and re-run `pre-kompl ingest` |
| Canonicalization-rules version bumped | DB will refuse to ingest until you wipe (a migration tool is the longer-term answer) |

The changelog you receive with each pre-kompl update will tell you which one.

`reclassify` is idempotent: running it against an already-current DB prints `Nothing to reclassify — every existing row already matches current rules.`

## Agent skill

[`skills/pre-kompl-search/SKILL.md`](./skills/pre-kompl-search/SKILL.md) is a model-agnostic skill file that teaches an LLM agent how to query your catalog correctly. The format follows the emerging agent-skills convention (YAML frontmatter with `name` + `description` so a host can decide when to load it, prose body for the model to read). Drop the `skills/` directory into whatever agent harness you use — anything that auto-discovers a `skills/` folder will pick it up; anything that doesn't, you can load the file manually.

What the skill knows:

- **The two access patterns.** Known-item search (*"that Karpathy GPT video"*) vs. subject search (*"what do I have on agent memory"*). Different phrasings, different ways to read the result set, both routed through the same `search` command.
- **When to use `--json` vs. pretty output.** Pretty for the human; `--json` envelope when the agent needs the facet counts to reason about refinements before answering.
- **The envelope shape.** `items[]`, `count`, `relaxed`, and `facets` with per-source / per-kind / per-folder / per-creator counts so the agent can suggest narrowings instead of dumping 100 hits.
- **The schema for the raw-SQL escape hatch.** When `search` doesn't fit — date ranges, exact URL lookups, dead-link cleanup, cross-creator joins — the skill lists the `instances`, `items`, `authorities` columns the agent needs and gives ready-to-use SQL recipes for creator browse, recent saves, folder tree, and dead-link audit.
- **Honest limits.** Catalog metadata is triage-grade (one-line GitHub descriptions, one-sentence og:descriptions). The skill tells the agent to say so plainly when asked comparative questions ("which is best for X") rather than fabricating answers from short descriptions.

You can also read `SKILL.md` as a human usage guide for the `search` command — it's written as prose, not as a magic incantation.

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
