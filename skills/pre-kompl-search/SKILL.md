---
name: pre-kompl-search
description: Use when the user asks about content in their pre-kompl catalog — saved bookmarks across YouTube, GitHub, Twitter, and web pages. Triggers include "what X do I have", "find my saved Y", "tools for Z", "did I bookmark anything about W", "show me my repos for", "videos I saved on", and similar questions about previously-bookmarked content. Catalog is a SQLite DB at $PRE_KOMPL_DB or ~/.pre-kompl/catalog.db.
---

# pre-kompl catalog search

The pre-kompl catalog is a personal bookmark catalog. Browser bookmark folders, if the user has any, are kept as an optional signal; notes files and Twitter exports carry no folders at all. The catalog stores Instances (one per real-world resource) and Items (one per bookmark — multiple Items can point at the same Instance).

## Two access patterns

This is the classical LIS dichotomy. Identify which one the user is doing before you query:

- **Known-item search (KIS)**: user remembers something specific exists and wants to retrieve it. Phrases: "the nanoGPT repo", "that Karpathy GPT video", "Pliny's bookmark prompt tweet". Top hit is usually the answer.
- **Subject search**: user wants resources ON a topic. Phrases: "what do I have on agent memory", "cybersecurity repos", "tools for agents". Returns a set; user picks from it.

The catalog is shaped for both: descriptive metadata (title, creator, URL) serves KIS, subject access points (folder paths, eventually subject authorities) serve subject search.

## The primary tool: `pre-kompl search`

Almost every catalog question goes through one CLI command. `pre-kompl` is the installed command (`npm link` or `npm install -g .` from the repo); inside the repo, `npx tsx --no-warnings src/cli.ts` is equivalent.

```
pre-kompl search "<query>" [--source <list>] [--kind <list>] [--folder <prefix>]
                           [--creator <list>] [--topic <list>]
                           [--status <list> | --status all] [--partial <list>]
                           [--limit <n>] [--json]
```

Filter flags accept comma-separated values. `--creator` prefix-matches authority preferred names (case-insensitive). `--topic` prefix-matches GitHub topic tags from `source_payload_json.topics[]` (GitHub repos only).

Defaults:
- `--status ok` — partial/error rows excluded. Use `--status all` to include them, or `--partial dead_link --status all` to surface specifically that class. When the default hides matching partial rows, the result says how many (`hidden_partial_count`).
- `--limit 20`
- Without `--json`, prints a human-readable Discovery-layer-shaped view: ranked items grouped by source, then a facet panel with refinement suggestions.

The search uses SQLite FTS5 with BM25 ranking, prefix-matching (`agent` matches `agents`, `agentic`, `agentmemory`), and porter stemming for English. Stopwords (`for`, `with`, `the`, etc.) are dropped automatically — so "tools for agents" is treated as "tools agents". Punctuation is a word break (`iana.org` → `iana org`, `gpt-4` → `gpt 4`); single characters are dropped, so `c++` alone has nothing to search on.

Zero results trigger automatic relaxation: drop the rightmost token and retry (`relaxed_mode: "drop_token"`). If still zero and the original query had 2+ tokens, retry once with OR across all tokens (`relaxed_mode: "or"`). Single-token queries are not OR-relaxed — they are already broad. If all relaxation fails, the search returns honestly empty rather than throwing.

## When to use `--json` vs pretty output

For the user: pretty output, group by source, BM25-ranked.

For yourself (programmatic reasoning before answering the user): always use `--json`. The envelope is:

```json
{
  "query_raw": "what user asked",
  "query_executed": "the* sanitized* fts5* expression*",
  "relaxed": false,
  "relaxed_mode": "none",
  "items": [
    {
      "instance_id": "inst_gh_owner__repo",
      "source": "github",
      "kind": "github-repo",
      "title": "...",
      "description": "...",
      "url_canonical": "...",
      "ingest_status": "ok",
      "partial_reason": null,
      "creator_name": "preferred name + variants",
      "folder_paths": ["Research|Agents"],
      "topics": ["ai-memory", "agents"],
      "bm25_rank": -3.42
    }
  ],
  "count": 39,
  "hidden_partial_count": 4,
  "facets": {
    "source": {"github": 19, "web": 20},
    "kind": {"github-repo": 19, "article": 12, "docs": 8},
    "folder": [{"path": "...", "count": 16}, ...],
    "creator": [{"name": "...", "count": 4}, ...],
    "topic": [{"name": "ai-memory", "count": 3}, ...]
  }
}
```

`relaxed_mode` is `"none"`, `"drop_token"`, or `"or"`. `topics[]` is populated for GitHub repos (from indexed topic tags); empty for other sources. `folder_paths` is empty for bookmarks outside any folder. `hidden_partial_count` is how many partial rows also matched but were hidden by the default `--status ok` (always 0 when `--status` is set). It is common when the user ingested without API keys, since GitHub/YouTube saves then land as `partial / missing_api_key` with only the saved title and URL.

`facets` is the heart of the discovery-layer pattern. They tell you what refinements the user could make. Use them in your answer: "you have 39 results, 19 GitHub repos and 20 web articles, mostly in your Research folder (16) — want me to narrow?" (mention folders only if `facets.folder` is non-empty).

## The schema (for when you need raw SQL)

If `pre-kompl search` doesn't fit (date ranges, exact URL lookup, custom aggregations, dead-link cleanup), drop to the read-only `sql` subcommand:

```bash
pre-kompl sql "SELECT ..." [--json] [--limit <n>]
```

Works on Windows without the `sqlite3` CLI installed. Uses the same `PRE_KOMPL_DB` / `.env` as other commands. Only `SELECT` / `WITH` queries are allowed. Default output is pipe-separated with a header row; `--json` returns an array of row objects.

Tables that matter:

`instances` — one row per real-world resource
- `id` PRIMARY KEY
- `source` — 'youtube' | 'github' | 'twitter' | 'web'
- `kind` — 'video' | 'creator-page' | 'github-repo' | 'tweet' | 'article' | 'paywalled' | 'not-html'
- `url_canonical` — normalized URL (dedup key)
- `title`, `description` — surface metadata. Length varies by source: GitHub gives ~one line, YouTube 1-2 paragraphs, web's og:description ≤200 chars
- `creator_authority_id` → authorities.id
- `ingest_status` — 'ok' | 'partial' | 'error'
- `partial_reason` — when partial: 'missing_api_key' (GitHub/YouTube saved without a key; title and URL come from the bookmark), 'empty_text' (tweet URL seen only in a browser bookmark or notes file), 'truncated_text', 'dead_link', 'paywalled', 'blocked', 'brand_default_title', 'failed', 'not_html'
- `fetched_at` — unix epoch ms
- GitHub repo `topics[]` — stored in `source_payload_json` at ingest and copied into the FTS `topics` column (searchable via `pre-kompl search`). Not mapped to `subject_authority_ids` yet — see repo `docs/decisions/subject-authorities-deferred.md`.

`items` — one row per bookmark (multiple Items can point at the same Instance)
- `instance_id` FK → instances.id
- `url_as_saved` — exact URL bookmarked (preserves intent — use for click-through)
- `bookmark_folder_path` — pipe-separated, "Folder|Subfolder"; `''` when the bookmark sat outside any folder or the source has no folders. Browser root containers ("Bookmarks bar", "Other bookmarks", "Bookmarks Menu", ...) are stripped.
- `save_date` — unix epoch **milliseconds** (divide by 1000 for SQLite `datetime(..., 'unixepoch')`)

`authorities` — controlled vocabulary
- `type` — 'creator' | 'subject'
- `preferred` — canonical display name
- `variants_json` — JSON array of alternate names

## The folders question

Folders are optional. Many users have none, or only a few. When they exist, folder names are the user's personal pre-coordinate classification (Ranganathan PMEST-style: they've decomposed each bookmark into facets and concatenated them into a folder path). They are searchable — the FTS row includes folder segments, so a query "trading agents" matches the folder `Research|Trading Agents` via the "trading" + "agents" tokens.

Do NOT hard-code folder name mappings. Different users have different folder schemes; some have no useful folders at all. Let the FTS handle it: queries that match folder tokens will surface those rows. Use the `facets.folder` in the response to learn THIS user's taxonomy from the result set.

When a user's question maps cleanly to a folder ("anything in my Research folder"), use `--folder` directly:

```
pre-kompl search "agent memory" --folder "Research"
```

`--folder` is a prefix match on the stored path, so `--folder "Research"` also covers `Research|Agents`. But don't assume; check first by running the bare search and reading `facets.folder`.

## Honest limits to surface

- **Descriptions are short.** GitHub gives ~one line, web's og:description is one sentence. If user asks comparative questions ("which is best for X", "does Y handle streaming"), the catalog has triage-grade metadata, not body content. Say so plainly. Don't fabricate. Offer to list the candidates so they can open and compare.
- **Folder match is keyword-shaped.** If user types "neuroscience" and their folders are all named "Coding" / "Trading" / "Health", folder facet won't help. Keyword search across titles/descriptions still works.
- **Partial rows are excluded by default.** If `hidden_partial_count > 0`, rerun with `--status all` before saying "nothing found": without API keys, every GitHub/YouTube save is partial. Use `--partial dead_link --status all` to surface cleanup candidates.

## Agent query playbook

Follow this multi-pass flow before answering catalog questions:

1. **Always start** with `pre-kompl search "<phrase>" --json`. Identify KIS vs subject search from the user's phrasing.
2. **Subject questions take several searches.** The catalog matches keywords, not sentences: turn the question into 2–4 keyword searches (the core term, a synonym, a narrower `--source` or `--kind` pass where the facets suggest it), then merge the hits by `instance_id` so a resource found twice is listed once. Answer from the merged set, grouped by kind or source, with a short note on why each top hit fits the question.
3. **If `count === 0`:** shorten the query → try anchor synonyms (e.g. "memgpt" → "memory") → try single-token searches → read `facets.folder` from a broad `--limit 5` probe if needed.
4. **If subject + inventory question** ("how many X do I have"): dedupe by `instance_id` in your head — multiple Items can point at the same Instance; don't count duplicate rows as separate resources.
5. **Status scope:** default `--status ok` for "useful stuff"; `--status all` for audit/debug or dead-link cleanup.
6. **When to refine:** read `facets` and offer `--source`, `--folder`, `--creator`, or `--topic` narrowings when the result set is large or ambiguous.
7. **Response template:** state count + source/kind split + dominant folder (only if the user has folders) + top 3–5 hits + one refinement offer.

Examples of facet-driven refinement:

```
pre-kompl search "memory" --creator vectorize --json
pre-kompl search "" --topic ai-memory --source github --json
```

## Patterns

**Subject search**: just call `pre-kompl search "<topic>" --json`, summarize the count + top hits + dominant facets, offer narrowings.

**Known-item search**: same, but treat the top result as the answer when BM25 rank is high and the query was specific.

**Creator browse** ("what else by X") — prefer search filters when possible:
```bash
pre-kompl search "" --creator Karpathy --json
```

For joins search can't express:
```bash
pre-kompl sql \
  "SELECT i.title, i.url_canonical, i.source FROM instances i
   JOIN authorities a ON i.creator_authority_id = a.id
   WHERE a.preferred LIKE '%Karpathy%' AND i.ingest_status='ok'"
```

**Recent saves**:
```bash
pre-kompl sql \
  "SELECT i.title, i.source, datetime(it.save_date/1000,'unixepoch') AS saved
   FROM items it JOIN instances i ON it.instance_id = i.id
   WHERE i.ingest_status = 'ok'
   ORDER BY it.save_date DESC LIMIT 20"
```

**Folder tree** (when no match, show user what they have; empty if they don't use folders):
```bash
pre-kompl sql \
  "SELECT bookmark_folder_path, COUNT(*) c FROM items
   WHERE bookmark_folder_path != ''
   GROUP BY bookmark_folder_path ORDER BY c DESC"
```

**Dead-link cleanup**: `pre-kompl search "" --partial dead_link --status all --limit 100 --json` or via `pre-kompl partials`.
