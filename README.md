# pre-KOMPL

A personal bookmark catalog, built the way libraries build catalogs and scaled down for you. Your agent builds it, maintains it and searches it for you.

pre-KOMPL takes the exports you already have (browser bookmarks, X bookmarks, notes full of links), describes every link with structured metadata, merges the same link saved in different places and indexes it all in one SQLite file on your machine. You ask your agent a question in plain words. Through the included skill it runs several searches, merges what they find, and tells you what you actually saved on the topic and what's worth opening.

The library-science background behind the design is summarised in [Built on library science](#built-on-library-science).

## Why

Saves end up in silos. Browser bookmarks sit in folder trees that decay as they grow. X bookmarks live in another tool, starred repos and YouTube videos in their own apps, and links are scattered across notes files. Each silo has its own weak search, and none of them know about the others.

The questions you actually ask cross all of them. "What do I have on agent memory?" needs repos, talks and articles together. "That talk I saved around the same time as the nanoGPT repo" needs dates across sources. pre-KOMPL doesn't ask you to re-file anything. It catalogs what's already there, flags dead links and failed fetches instead of dropping them, and gives one ranked answer across every source.

## Use it through your agent

The skill in [`skills/pre-kompl-search/`](./skills/pre-kompl-search/SKILL.md) is what makes pre-KOMPL useful day to day. One question to the agent becomes a small search session:

- it turns your question into keyword searches, because a catalog matches words, not sentences
- it reads the facet counts (source, kind, creator, folder) and narrows or widens from there
- it relaxes a query that finds nothing, and drops to read-only SQL for dates and exact lookups
- it merges the hits from every search, removes repeats, and answers with the links grouped and commented
- it says plainly when metadata is thin: the catalog holds one-line descriptions, not page contents

So "what did I save about showing uncertainty in AI answers?" comes back as the papers, talks, repos and posts you saved on it, with a line on why each one matters, instead of a raw result list.

To install the skill, copy the `skills/pre-kompl-search/` folder into the skills directory your agent loads from (for Claude Code, `~/.claude/skills/`). The skill calls the `pre-kompl` command, so run `npm link` once in the repo folder (see [Install](#install)). Agents without skill support can be given `SKILL.md` as plain instructions.

## pre-KOMPL and KOMPL

The name says where it sits: before [KOMPL](https://github.com/tuirk/Kompl). pre-KOMPL was originally designed as a cheap layer in front of KOMPL's costly ingest, but it works on its own. Skip this section if you don't use KOMPL.

Together they split the work the way libraries do: the catalog indexes descriptions cheaply, and the repository holds and processes the full text. KOMPL reads every source in full and compiles it into a wiki, which costs time, LLM tokens and scraping credits for each one. pre-KOMPL is for when you don't yet know what you have. Catalog everything for a few API calls, see what's there, and send only what's worth that cost to KOMPL.

## Install

Needs Node.js 22 or newer.

```bash
git clone https://github.com/tuirk/pre-KOMPL.git
cd pre-KOMPL
npm install
npm link        # puts the pre-kompl command on your PATH, for you and your agent
```

`better-sqlite3` ships prebuilt binaries for Windows, macOS and Linux on current Node versions, so common platforms need no compiler. There is no build step; TypeScript runs through `tsx`. Without `npm link`, run the CLI from the repo folder as `npx pre-kompl <command>`.

## Build your catalog

```bash
# Put your exports in one folder: the browser's bookmarks .html,
# an X bookmarks .json, any notes files with links. Then:
pre-kompl ingest ~/bookmark-exports
pre-kompl status
```

Re-running `ingest` on the same folder is cheap: resources already in the catalog are not fetched again. The catalog lives at `~/.pre-kompl/catalog.db`. Set `PRE_KOMPL_DB` to use a different file, or `PRE_KOMPL_HOME` to move the whole folder.

Then ask your agent. Or search yourself, see [Search from the command line](#search-from-the-command-line).

### What it reads

`ingest` walks the folder and its subfolders (skipping dotfiles and `node_modules`) and sniffs each file's content, so file names don't matter.

| Input | Details |
| --- | --- |
| Browser bookmark exports (Netscape HTML) | The "Export bookmarks" file from Chrome, Brave, Edge, Firefox or Safari. Folders are kept. |
| X/Twitter bookmark JSON | The common shapes produced by bookmark-export browser extensions, bookmarklets and CLI tools. |
| Notes files | Any text file containing URLs (`.md`, `.txt`, ...): markdown links and bare URLs. |

Binary files and text without URLs are skipped and listed in the ingest output. Each URL goes to one of four pipelines: YouTube, GitHub, X/Twitter or general web. GitHub gists are logged as unsupported (`pre-kompl errors`).

### API keys are optional

Everything works without keys. Keys add metadata:

| Variable | What it adds | Without it |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | Video title, description, channel, tags, duration; channel and playlist pages resolved | Stored as `partial / missing_api_key`, keeping the bookmark's title and URL |
| `GITHUB_TOKEN` | Repo description, topics (searchable), languages, stars | Stored as `partial / missing_api_key`, keeping the bookmark's title and URL |
| `FIRECRAWL_API_KEY` | A JS-rendering fallback for web pages that block or fail the direct fetch (1 credit per page) | The page keeps whatever the direct fetch got |
| `FIRECRAWL_BUDGET` | Cap on Firecrawl credits per ingest run (default 500) | |

Put them in a `.env` file in the repo folder (`cp .env.example .env`). It is loaded on every run, wherever you run `pre-kompl` from. Exporting them in your shell works too.

Web pages need no key: pre-KOMPL fetches the start of each page directly to read its title and description. X/Twitter never uses an API; tweet text comes from your JSON export. A tweet URL that only appears in a browser bookmark or notes file is stored as `partial / empty_text` with the bookmark's title.

Partial rows are hidden from search by default because their metadata is thin. When a search hides matching partials it says so, for example `→ 3 partial matches hidden — use --status all to include them.` `pre-kompl partials` lists them grouped by reason. Adding a key later doesn't upgrade existing rows; see [Re-ingest or reclassify](#re-ingest-or-reclassify).

### Folders are optional

Browser folders, if you have them, are kept as one more search signal. Notes files and X exports have no folders, and nothing depends on them. The browser's own root containers ("Bookmarks bar", "Other bookmarks", "Bookmarks Menu", "Favorites bar" and so on) are dropped: a bookmark under Bookmarks bar → Research is stored as `Research`, and one sitting directly in the bar has no folder. Nested folders are joined with `|`, as in `Research|Agents`.

## Built on library science

Libraries have spent 150 years on the problems a pile of bookmarks has. pre-KOMPL borrows the patterns that still work at the scale of one person's saves:

| Problem | Library answer | In pre-KOMPL |
| --- | --- | --- |
| The same resource saved twice, in different places | Work / Instance / Item (FRBR, [BIBFRAME](https://www.loc.gov/bibframe/)) | Each save is an Item. The resource it points at is an Instance, so saves of the same video, repo or tweet collapse onto one Instance through its canonical ID. Works sit above Instances. |
| Organising things on several axes at once | Faceted, post-coordinate classification (Ranganathan) | Kind, source, creator, folder, date and status are stored separately and combined at search time, instead of filing each save in one tree |
| One creator, many names | Authority control (Cutter) | Each creator gets one authority record per platform, holding the display name and the handle as a variant. Both are indexed, so `David Bombal` and `@davidbombal` reach the same saves |
| Links rot and move | Access points (MARC 856) | Each save keeps the URL exactly as saved, for opening, and a canonical URL, for matching. Dead links are flagged, never dropped |
| "Find that one thing" versus "what do I have on X" | Known-item versus subject search (Tagliacozzo & Kochen, 1970) | BM25 full-text search for known items. Facet counts and query relaxation for subject searches, in the discovery-layer pattern: one search box, refine afterwards |

Some library patterns don't scale down, and pre-KOMPL leaves them out on purpose. Grouping several Instances under one Work (the talk and the repo of the same project) isn't built, because personal saves rarely hold one creation in several forms. Controlled subject headings would need hand curation; folder names and full-text search cover that ground. Full page text and embeddings belong in a content store like KOMPL, not in a catalog.

**Further reading:** C. A. Cutter, *Rules for a Dictionary Catalog* (1876); S. R. Ranganathan, *Colon Classification* (1933); IFLA, *Functional Requirements for Bibliographic Records* (1998); Library of Congress, *BIBFRAME 2.0*; R. Tagliacozzo & M. Kochen, "Information-seeking behavior of catalog users" (1970); S. Robertson & S. Walker, "Some simple effective approximations to the 2-Poisson model for probabilistic weighted retrieval" (1994, the BM25 paper); E. Svenonius, *The Intellectual Foundation of Information Organization* (2000).

## Search from the command line

This is the same search the skill uses. It's handy for quick lookups and for scripts.

```bash
pre-kompl search "agent memory"
pre-kompl search "rag" --source github
pre-kompl search "" --folder "Research"
pre-kompl search "memory" --creator vectorize
pre-kompl search "" --topic ai-memory --source github
pre-kompl search "trading" --kind video --limit 50
pre-kompl search "" --partial dead_link --status all
pre-kompl search "agents" --json
```

Search is one BM25-ranked full-text query across title, description, folder names, creator, URL and GitHub topics. Every word must match, so use keywords rather than sentences. Words are prefix-matched (`agent` also finds `agents` and `agentmemory`), English words are stemmed, and common stopwords are dropped. Punctuation counts as a word break, so `iana.org` searches for `iana` and `org`, and single characters are ignored. If nothing matches, the query is relaxed by dropping the last word, then by OR-ing the words.

| Flag | Meaning |
| --- | --- |
| `--source <list>` | `github`, `youtube`, `web`, `twitter` (comma-separated) |
| `--kind <list>` | e.g. `video`, `github-repo`, `article`, `tweet`, `docs`, `paper` |
| `--folder <prefix>` | Folder path starts with this, e.g. `Research` or `Research\|Agents` |
| `--creator <list>` | Creator name prefix, e.g. a YouTube channel |
| `--topic <list>` | GitHub topic prefix |
| `--status <list>` | Ingest status, default `ok`; `--status all` includes partial rows |
| `--partial <list>` | Partial reason, e.g. `dead_link`, `missing_api_key`; use with `--status all` |
| `--limit <n>` | Number of results, default 20, max 100 |
| `--json` | Full result envelope (hits, facet counts, relaxation, hidden partial count) |

An empty query needs at least one filter. The default output groups hits by source and ends with refinement suggestions drawn from the facet counts.

### Other commands

| Command | What it does |
| --- | --- |
| `pre-kompl status` | Counts by source, kind and status |
| `pre-kompl partials [-n <count>]` | Incomplete rows, grouped by reason |
| `pre-kompl errors [-n <count>]` | Inputs that failed to ingest |
| `pre-kompl reclassify` | Re-applies logic-only rules (dead-link detection and similar) to existing rows; no network |
| `pre-kompl rebuild-fts` | Rebuilds the search index; normally automatic |
| `pre-kompl sql "<query>"` | Read-only SQL, see below |

### Read-only SQL

For questions `search` can't express (date ranges, exact URL lookups, custom counts):

```bash
pre-kompl sql "SELECT bookmark_folder_path, COUNT(*) c FROM items GROUP BY 1 ORDER BY c DESC LIMIT 5"
pre-kompl sql "SELECT title, source FROM instances WHERE ingest_status = 'ok'" --limit 10 --json
```

The database is opened read-only and only `SELECT` / `WITH` statements are accepted. Output is pipe-separated with a header row, or an array of row objects with `--json`. `--limit <n>` appends a `LIMIT` when the query has none. No `sqlite3` binary is needed. The main tables are `instances` (one row per resource), `items` (one row per save; `save_date` is in milliseconds) and `authorities` (creators); the skill file lists their columns.

### Re-ingest or reclassify

Ingest skips resources already in the catalog, so it never re-fetches them.

- When an update only changes logic (dead-link detection, status rules), run `pre-kompl reclassify`. It's fast, deterministic and costs no API calls.
- When you need fresh data, for example after adding an API key, delete the catalog file and run `ingest` again.
- If `CANONICALIZATION_RULES_VERSION` in `src/config.ts` changes, the old catalog refuses to open until you delete it and re-ingest.

## Your data stays local

The catalog is a single SQLite file on your machine. Network calls happen only during `ingest`: to the bookmarked web pages (to read titles and descriptions) and to the YouTube, GitHub and Firecrawl APIs if you set keys. `search`, `sql`, `status` and the other commands run offline. There is no telemetry. Your agent sees whatever the searches return, so the usual rules of the agent you use apply.

## Development

`npm run typecheck` is the correctness gate; there is no test runner. [AGENTS.md](./AGENTS.md) covers the data model and code conventions.

## License

[MIT](./LICENSE)
