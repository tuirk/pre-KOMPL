---
name: pre-kompl-search
description: Use when the user asks about content in their pre-kompl catalog — saved bookmarks across YouTube, GitHub, Twitter, and web pages. Triggers include "what X do I have", "find my saved Y", "tools for Z", "did I bookmark anything about W", "show me my repos for", "videos I saved on", and similar questions about previously-bookmarked content. Catalog is a SQLite DB at $PRE_KOMPL_DB or ~/.pre-kompl/catalog.db.
---

# pre-kompl catalog search

The pre-kompl catalog is a personal bookmark catalog. The user has organized their bookmarks into folders before saving them. The catalog stores Instances (one per real-world resource) and Items (one per bookmark — multiple Items can point at the same Instance).

## Two access patterns

This is the classical LIS dichotomy. Identify which one the user is doing before you query:

- **Known-item search (KIS)**: user remembers something specific exists and wants to retrieve it. Phrases: "the nanoGPT repo", "that Karpathy GPT video", "Pliny's bookmark prompt tweet". Top hit is usually the answer.
- **Subject search**: user wants resources ON a topic. Phrases: "what do I have on agent memory", "cybersecurity repos", "tools for agents". Returns a set; user picks from it.

The catalog is shaped for both: descriptive metadata (title, creator, URL) serves KIS, subject access points (folder paths, eventually subject authorities) serve subject search.

## The primary tool: `pre-kompl search`

Almost every catalog question goes through one CLI command:

```
pre-kompl search "<query>" [--source <list>] [--kind <list>] [--folder <prefix>]
                           [--status <list> | --status all] [--partial <list>]
                           [--limit <n>] [--json]
```

Defaults:
- `--status ok` — partial/error rows excluded. Use `--status all` to include them, or `--partial dead_link` to surface specifically that class.
- `--limit 20`
- Without `--json`, prints a human-readable Discovery-layer-shaped view: ranked items grouped by source, then a facet panel with refinement suggestions.

The search uses SQLite FTS5 with BM25 ranking, prefix-matching (`memory` matches `memories`, `memgpt`, `agentmemory`), and porter stemming for English. Stopwords (`for`, `with`, `the`, etc.) are dropped automatically — so "tools for agents" is treated as "tools agents".

Zero results trigger automatic relaxation (drop the rightmost token and retry). If still zero, the search returns honestly empty rather than throwing.

## When to use `--json` vs pretty output

For the user: pretty output, group by source, BM25-ranked.

For yourself (programmatic reasoning before answering the user): always use `--json`. The envelope is:

```json
{
  "query_raw": "what user asked",
  "query_executed": "the* sanitized* fts5* expression*",
  "relaxed": false,
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
      "folder_paths": ["Bookmarks|...|..."],
      "bm25_rank": -3.42
    }
  ],
  "count": 39,
  "facets": {
    "source": {"github": 19, "web": 20},
    "kind": {"github-repo": 19, "article": 12, "docs": 8},
    "folder": [{"path": "...", "count": 16}, ...],
    "creator": [{"name": "...", "count": 4}, ...]
  }
}
```

`facets` is the heart of the discovery-layer pattern. They tell you what refinements the user could make. Use them in your answer: "you have 39 results, 19 GitHub repos and 20 web articles, mostly in your Trading Agents folder (16) — want me to narrow?"

## The schema (for when you need raw SQL)

If `pre-kompl search` doesn't fit (date ranges, exact URL lookup, custom aggregations, dead-link cleanup), drop to SQL:

```bash
sqlite3 "${PRE_KOMPL_DB:-$HOME/.pre-kompl/catalog.db}" -header -separator '|' "<query>"
```

Tables that matter:

`instances` — one row per real-world resource
- `id` PRIMARY KEY
- `source` — 'youtube' | 'github' | 'twitter' | 'web'
- `kind` — 'video' | 'creator-page' | 'github-repo' | 'tweet' | 'article' | 'paywalled' | 'not-html'
- `url_canonical` — normalized URL (dedup key)
- `title`, `description` — surface metadata. Length varies by source: GitHub gives ~one line, YouTube 1-2 paragraphs, web's og:description ≤200 chars
- `creator_authority_id` → authorities.id
- `ingest_status` — 'ok' | 'partial' | 'error'
- `partial_reason` — when partial: 'dead_link', 'paywalled', 'blocked', 'brand_default_title', 'failed', 'not_html'
- `fetched_at` — unix epoch ms

`items` — one row per bookmark (multiple Items can point at the same Instance)
- `instance_id` FK → instances.id
- `url_as_saved` — exact URL bookmarked (preserves intent — use for click-through)
- `bookmark_folder_path` — pipe-separated, "Bookmarks|Folder|Subfolder"
- `save_date` — unix epoch seconds

`authorities` — controlled vocabulary
- `type` — 'creator' | 'subject'
- `preferred` — canonical display name
- `variants_json` — JSON array of alternate names

## The folders question

User folder names are their personal pre-coordinate classification (Ranganathan PMEST-style: they've decomposed each bookmark into facets and concatenated them into a folder path). They are searchable — the FTS row includes folder segments, so a query "trading agents" matches the folder `Bookmarks|Cyber DYOR|A.I.|Trading Agents` via the "trading" + "agents" tokens.

Do NOT hard-code folder name mappings. Different users have different folder schemes; some have no useful folders at all. Let the FTS handle it: queries that match folder tokens will surface those rows. Use the `facets.folder` in the response to learn THIS user's taxonomy from the result set.

When a user's question maps cleanly to a folder ("anything in my AI folder"), use `--folder` directly:

```
pre-kompl search "agent memory" --folder "Bookmarks|Cyber DYOR|A.I."
```

But don't assume; check first by running the bare search and reading `facets.folder`.

## Honest limits to surface

- **Descriptions are short.** GitHub gives ~one line, web's og:description is one sentence. If user asks comparative questions ("which is best for X", "does Y handle streaming"), the catalog has triage-grade metadata, not body content. Say so plainly. Don't fabricate. Offer to list the candidates so they can open and compare.
- **Folder match is keyword-shaped.** If user types "neuroscience" and their folders are all named "Coding" / "Trading" / "Health", folder facet won't help. Keyword search across titles/descriptions still works.
- **Partial rows are excluded by default.** Use `--status all` to include them, or `--partial dead_link` to surface cleanup candidates.

## Patterns

**Subject search**: just call `pre-kompl search "<topic>" --json`, summarize the count + top hits + dominant facets, offer narrowings.

**Known-item search**: same, but treat the top result as the answer when BM25 rank is high and the query was specific.

**Creator browse** ("what else by X"):
```bash
sqlite3 "${PRE_KOMPL_DB:-$HOME/.pre-kompl/catalog.db}" -header -separator '|' \
  "SELECT i.title, i.url_canonical, i.source FROM instances i
   JOIN authorities a ON i.creator_authority_id = a.id
   WHERE a.preferred LIKE '%Karpathy%' AND i.ingest_status='ok'"
```

**Recent saves**:
```bash
sqlite3 "${PRE_KOMPL_DB:-$HOME/.pre-kompl/catalog.db}" -header -separator '|' \
  "SELECT i.title, i.source, datetime(it.save_date,'unixepoch') AS saved
   FROM items it JOIN instances i ON it.instance_id = i.id
   WHERE i.ingest_status = 'ok'
   ORDER BY it.save_date DESC LIMIT 20"
```

**Folder tree** (when no match, show user what they have):
```bash
sqlite3 "${PRE_KOMPL_DB:-$HOME/.pre-kompl/catalog.db}" -header -separator '|' \
  "SELECT bookmark_folder_path, COUNT(*) c FROM items
   WHERE bookmark_folder_path != ''
   GROUP BY bookmark_folder_path ORDER BY c DESC"
```

**Dead-link cleanup**: `pre-kompl search "" --partial dead_link --limit 100 --json` or via `pre-kompl partials`.
