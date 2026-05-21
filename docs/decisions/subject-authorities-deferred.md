# Decision: GitHub topics → FTS now, subject authorities later

**Status:** accepted (2026-05-30)  
**Supersedes:** storing topics only in `source_payload_json` with no search path

## What we did (option C)

GitHub repo `topics[]` are copied into a dedicated **`topics` column** on `instances_fts` at index time (`upsertInstanceFts` in `src/db.ts`). `pre-kompl search` matches them alongside title, description, folder paths, creator name, and URL.

Schema bumps are tracked via `meta.fts_schema_version`. On open, `openDb()` drops/recreates the FTS virtual table and rebuilds rows when the version changes.

## What we did not do (option A)

The spec’s intended path: each topic string → a **subject authority** record (`auth_sub_*`) → `subject_authority_ids_json` on the instance → subject facet browse/filter.

That column still inserts as `'[]'` everywhere. No `findOrCreateSubjectAuthority` exists in v0.

## Why A is deferred (ROI)

| Factor | Reality |
|---|---|
| **Input sparsity** | Empirical test in spec: ~**1/8** GitHub repos have topics set. Building authority infrastructure for a field most rows lack is low immediate payoff. |
| **Implementation cost** | A needs subject authority CRUD, ingest wiring, facet queries, dedup/normalization (`pytorch` vs `PyTorch`), and spec alignment — days, not hours. |
| **User pain today** | Topics were stored but invisible to search (e.g. webclaw tagged `firecrawl-alternative` but `search "firecrawl"` returned zero). C fixes that with minimal surface area. |
| **Loss we accept** | No `--subject` facet, no hierarchy (`ml` ⊃ `pytorch`), no controlled vocabulary. Junk tags (`ai`, `tools`) can pollute BM25 rank. |
| **Loss we do not accept** | Repos where the topic is the *only* signal (`ml-utils` tagged `pytorch`, description silent) staying unfindable. |

## When to revisit A

- Subject facet becomes a product requirement (“browse everything tagged ai-memory”).
- YouTube tags / channel subjects get wired into the same subject axis (spec already plans this).
- Topic coverage in the corpus rises materially above the 1/8 baseline.
- You need deduped subject labels across sources, not just GitHub strings.

## Relationship between C and A

C does not block A. Later: populate `subject_authority_ids_json` from topics *and* keep the FTS `topics` column for free-text recall, or fold canonical subject names into FTS from authority preferred names.

## References

- `src/db.ts` — `FTS_SCHEMA_VERSION`, `extractFtsTopics`, `migrateInstancesFtsIfNeeded`
- `pre-kompl-spec/sources/github.md` — topics-are-sparse finding
- `pre-kompl-spec/architecture/facets.md` — subject facet design
