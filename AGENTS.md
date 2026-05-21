# AGENTS.md

Guidance for coding agents working in this repo. Follows the [agents.md](https://agents.md) convention — drop this in any agent harness that auto-loads it. Humans should still read [README.md](./README.md) for product context.

## What this project is

`pre-kompl` is a lightweight bookmark catalog. It ingests messy bookmark exports (browser HTML, Twitter JSON, notes files) into a local SQLite database with FTS5 search. Sits beneath the larger `kompl` project but ships independently.

Three things matter:

1. **The model** — `Work` / `Instance` / `Item`. Items are bookmarks (a save event); Instances are real-world resources (one per canonical URL); Works are intellectual creations grouping Instances (currently 1:1 with Instance — Work-grouping isn't being built, see [pre-kompl-spec/](./pre-kompl-spec/)).
2. **Never-drop** — every input becomes a row. If we can't fetch a URL, the Instance is stored with `ingest_status='partial'` and a `partial_reason`, not skipped. Agents must preserve this invariant.
3. **Versioned canonicalization** — URL normalization rules are versioned (`CANONICALIZATION_RULES_VERSION` in `src/config.ts`). If you change canonicalization logic, bump the version; the DB will refuse to ingest until the on-disk version matches.

## Setup

Node 22+. No build step (TypeScript runs through `tsx`).

```bash
npm install
```

Storage defaults to `~/.pre-kompl/catalog.db`. Override with `PRE_KOMPL_DB` and/or `PRE_KOMPL_HOME`. Tests and ad-hoc runs should point `PRE_KOMPL_DB` at a scratch path — never write to the user's real catalog.

Optional env vars (degraded gracefully when absent):
- `YOUTUBE_API_KEY` — without it, YouTube Instances land as `partial / missing_api_key`
- `GITHUB_TOKEN` — same pattern for GitHub
- `FIRECRAWL_API_KEY` + `FIRECRAWL_BUDGET` — enables JS-rendered rescue for blocked web URLs

## Commands

```bash
# Type-check (the only correctness gate — there are no unit tests yet)
npx tsc --noEmit

# Run the CLI directly
npx tsx --no-warnings src/cli.ts <subcommand>

# Subcommands: ingest, status, errors, partials, reclassify, search, rebuild-fts
# See README.md "Run" and "Search" sections for examples.
```

There is no test runner, no linter, no formatter configured. Don't add them on a whim — ask first.

## Code layout

```
src/
  cli.ts              # commander entry point
  commands.ts         # CLI command handlers (one per subcommand)
  orchestrator.ts     # ingest pipeline coordinator
  db.ts               # SQLite schema + FTS5 maintenance (better-sqlite3)
  search.ts           # FTS5 query layer (BM25, prefix-match, auto-relax)
  config.ts           # env loading + canonicalization version constant
  context.ts          # IngestContext (carries db + counters + progress channel)
  canonicalize.ts     # URL normalization (per-source rules, versioned)
  url-classify.ts     # decide which source pipeline a URL belongs to
  dedup.ts            # composite-key dedup logic
  authorities.ts      # creator/subject authority records
  authority-lookup.ts # find-or-create an authority by URL handle
  reclassify.ts       # re-apply pure-logic rules to existing rows
  firecrawl.ts        # Firecrawl /v2/scrape rescue path for web URLs
  types.ts            # RawBookmark, Kind, shared types
  parsers/
    browser-bookmarks.ts  # Netscape bookmark HTML
    notes-file.ts         # any text file containing URLs
    twitter-parser.ts     # 7 Twitter JSON export shapes (vendor-copied from kompl)
    web-peek.ts           # og:tag scraper + brand-default-title detector
  sources/
    youtube.ts / github.ts / twitter.ts / web.ts
                          # one pipeline per source; each must:
                          #   1) upsert the Instance
                          #   2) call upsertInstanceFts(db, instance_id)
                          #   3) write the Item
                          #   4) call upsertInstanceFts again (folder_paths may have changed)
```

## Conventions

- **TypeScript strict mode.** `tsconfig.json` has `"strict": true`. Don't relax it.
- **ESM only.** `"type": "module"`. Use `.js` extensions in imports (`./db.js` even though the file is `db.ts`).
- **SQLite access** goes through `better-sqlite3` (synchronous API). Don't introduce another driver. Don't add an async query layer.
- **FTS5 maintenance** is manual via `upsertInstanceFts` / `removeInstanceFts` in `db.ts`. Every code path that INSERTs or UPDATEs an Instance row, or that writes an Item whose `bookmark_folder_path` is new, must call `upsertInstanceFts(db, instance_id)` after the write. Triggers were considered and rejected — explicit calls are auditable.
- **Idempotent schema.** `CREATE TABLE IF NOT EXISTS` everywhere. Schema migrations live inline in `openDb`; bump `CANONICALIZATION_RULES_VERSION` only when canonicalization rules themselves change, not for arbitrary schema edits.
- **Dedup composites differ by source** — see the table in [README.md](./README.md#what-the-four-pipelines-do). Don't unify them.
- **Status semantics** are load-bearing: `ok` = fully fetched + parsed; `partial` = stored but degraded (always with a `partial_reason`); `error` = ingest itself failed (recoverable, surfaced in `ingestion_errors`). Functions that filter results should default to `ok`-only and require explicit broadening.
- **Comments explain the WHY, not the WHAT.** The existing codebase is heavy on `// because X happened, we Y` comments. Keep that style. Don't add JSDoc to internal helpers.
- **Don't invent test fixtures.** `test-fixtures/bookmarks-may-2026/` has hand-curated fixtures (real Twitter export, synthetic chrome export, notes file). If you need new coverage, extend those files; don't create parallel fixtures.
- **Don't touch `src/parsers/twitter-parser.ts`** without checking [README.md](./README.md#vendor-copied-files) — it's vendor-copied verbatim from `kompl` and is meant to stay 1:1.

## Gotchas

- **`@types/node` and `node:sqlite`.** Older code referenced `node:sqlite`. The driver is now `better-sqlite3`. If you see `node:sqlite` anywhere outside historical commits, fix it.
- **Folder paths are pipe-separated.** `"Bookmarks|Cyber DYOR|A.I."` — when writing them into FTS, split on `|` so each segment tokenizes independently (see `upsertInstanceFts` in `db.ts`).
- **Tweets in non-Twitter files** are real. A tweet URL inside a Chrome bookmark file gets synthesized into the Twitter pipeline as a URL-only entry, ingests as `partial / empty_text`, and dedups against the real Twitter JSON export later. See [README.md](./README.md#what-the-four-pipelines-do) bottom paragraph.
- **`reclassify` is logic-only.** It re-applies status rules to existing rows without network calls. Anything that needs a re-fetch requires deleting `~/.pre-kompl/catalog.db` and re-running ingest — there is no in-place re-fetch.
- **`rebuild-fts` exists** for upgrading from pre-FTS catalogs. Run it once after a clone+ingest if the FTS table looks empty.
- **CRLF on Windows.** Repo has no `.gitattributes` yet. Git will warn about LF→CRLF conversions on Windows clones; safe to ignore.

## Spec

The canonical design doc is in [`pre-kompl-spec/`](./pre-kompl-spec/) — 15 files, ~3800 lines. When in doubt about the data model, read it before reading the code. Spec drift between code and spec is a known risk; prefer the code as source of truth and propose a spec update if you find a divergence.

## How to make changes

- Small bug fix: edit the file, type-check (`npx tsc --noEmit`), commit.
- New behavior: skim the spec section for the affected concept first. If your change implies a spec edit, do both in the same commit.
- Schema change: decide whether it warrants a `CANONICALIZATION_RULES_VERSION` bump (only if URL canonicalization output would differ). Schema-only changes use `CREATE TABLE IF NOT EXISTS` and don't bump the version.
- New FTS-searchable field: add it to the `instances_fts` virtual table, update `upsertInstanceFts` to populate it, and run `rebuild-fts` against any existing DBs.
- Don't add dependencies casually. Current footprint is `better-sqlite3`, `cheerio`, `commander` — that's it. Each addition needs a justification.

## What not to do

- Don't add Jest, Vitest, ESLint, Prettier, Husky, or any other tooling without asking. The deliberate "no build step, no test runner" stance is a design choice for v0.
- Don't introduce a `dist/` build. `tsx` runs source directly.
- Don't add network calls to the search path. `search` and `rebuild-fts` are pure-local operations.
- Don't write to the user's `~/.pre-kompl/catalog.db` from tests or scratch scripts. Always use a scratch `PRE_KOMPL_DB` path.
- Don't drop rows silently. Never-drop principle applies to every code path that touches Items or Instances.
