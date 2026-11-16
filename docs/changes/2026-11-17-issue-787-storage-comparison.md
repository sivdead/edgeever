# #787: shared records, Free-plan capacity and physical-table comparison

## Current delivery and code

#805 retains the `a18db6a4` scope of named views and compatible performance improvements. Storage is a separate local candidate, without new Durable Objects, queues, Cloudflare bindings or dependencies. Production migration, clients, public forms and default backup entry points have not switched. The physical-table implementation remains a frozen comparison.

- [Shared store](../../apps/api/src/shared-table-store.ts): small headers hold fields, views, revision and count. Current records and immutable history are scoped by `workspace_id`/`table_id`; single-record edits do not rewrite the table document.
- [Query layout](../../apps/api/src/shared-table-query.ts), [compiler](../../apps/api/src/table-record-query.ts) and [indexes](../../apps/api/src/shared-table-index.ts): 50-record pages, one count on the first filtered request, metadata counts for unfiltered views. Saved views control field indexes; temporary queries create none. Small select groups reuse existing secondary indexes. Arbitrary unindexed sorts and larger option sets retain the existing path.
- [Type jobs](../../apps/api/src/shared-table-type-change.ts): strict preflight, representation confirmation, batched preparation, atomic publication and cancellation. Execution blocks this table's writes while old values remain readable. Revision-specific fields/cells support locally tested cross-type history and small ZIP round trips.
- [Local driver](../../scripts/experiments/shared-records/README.md): explicit experimental schema using the existing database adapter, with shared Cloudflare/Docker business logic. See the [implementation scope](2026-11-11-issue-787-record-storage-prototype.md).

## Cloudflare Free: distinguish limits, tested scale and estimates

As of 2026-11-17, **this candidate has no validated stable Workers Free data-volume ceiling**. Following the maintainer's local-only request, no cloud D1 capacity test was run. Local results do not establish request CPU, daily billed reads/writes or production migration acceptance.

| Constraint | Current interpretation |
| --- | --- |
| Existing product limit per table | 2,000 records and 40 fields, unchanged |
| D1 Free database | 500 MB per database; 5 GB/10 databases per account. The default single DB binding does not pool or shard the account allowance |
| Daily D1 Free | 5,000,000 rows read and 100,000 written; scans/index maintenance count, so returned rows or user operations are insufficient |
| Workers Free | 100,000 requests/day, 10 ms CPU per HTTP request; database waiting time is not CPU |
| R2 Standard attachments | 10 GB-month storage, 1 million Class A and 10 million Class B operations monthly, separate from D1 |

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 billing](https://developers.cloudflare.com/d1/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/). D1 also limits rows/strings to 2,000,000 bytes, SQL to 100 KB, bindings to 100, function arguments to 32 and LIKE/GLOB patterns to 50 bytes. A local regression explicitly applies the 50-byte pattern limit while retaining long UTF-16 boundary filters.

Local scale covers 2/10/30 tables of 1,000×10 and two rich-text tables of 1,950×38. These version-specific storage facts support arithmetic illustrations, not cloud guarantees:

| Synthetic input | Tested records | Complete experiment database | Candidate objects within it | 500,000,000-byte linear estimate using complete database | Candidate-only estimate |
| --- | ---: | ---: | ---: | ---: | ---: |
| Thirty 1,000×10 tables | 30,000 | 153.19 MiB | 50.87 MiB | about 93,000 records | about 281,000 |
| Two rich 1,950×38 tables | 3,900 | 166.10 MiB | 44.10 MiB | about 11,000 records | about 42,000 |

Complete files include legacy migration-input documents and baseline objects. Candidate objects include records, initial history, FTS, primary/unique indexes and controlled field indexes, excluding those legacy/baseline objects. Candidate bytes are not the whole database. The illustration uses `budget × tested records ÷ measured bytes` and 500,000,000 bytes, without asserting exact provider MB accounting or seeding the extrapolated scale. Other notes, retained legacy documents, further history/indexes and other objects reduce available space; growing table/index counts may also depart from linear growth. Attachment bodies occupy R2, but metadata can still occupy D1.

Consequently, neither the tested 30,000 records nor arithmetic estimates are a verified Free-plan limit. A stable ceiling requires representative values, history and access frequency, authorized isolated CPU/read/write tests, migration/backup and public-form acceptance, using whichever constraint is reached first. See [calculation inputs and fingerprints](evidence/2026-11-16-shared-records/capacity-and-physical-comparison.json).

## Frozen physical-table design

Each logical table has a server-named physical table. Small catalogs map workspace/table/stable field IDs to real columns, types, views and revisions. Numbers, booleans, dates and text use columns; attachment arrays retain JSON. Renaming display labels changes metadata, not column names. Filtering, ordering, cursors and pages share compiler logic, and column-to-response JSON assembly is included in measurements.

Value-compatible changes prefer metadata. Other conversions allocate a shadow column and prepare that field, related indexes and search projections in batches. Any failed conversion blocks publication; representation changes require confirmation. Execution pauses this table's writes while old values remain readable, then atomically switches mappings/dependencies. Cancellation and retired-column reclamation require task/column ownership checks to avoid clearing reused columns. The first physical prototype excluded cross-type historical replay; that was an implementation boundary, not a fundamental property of physical tables, and does not negate the maintainer's separate history tests.

Benefits are compact scalar storage and table-isolated index maintenance. Costs include column allocation, DDL, shadow columns, cancellation/reclamation and mapping-version consistency. Shared records remove that column lifecycle while still requiring transaction, index, search and history maintenance.

## Historical comparisons under matched conditions

These are frozen, same-run/same-input JSON partial-index versus physical-table comparisons. They are not directly comparable with the current shared candidate's different version, historical coverage or metrics. Environment: local Bun 1.3.14 / SQLite 3.54.0 / arm64; not browser/network latency, Workers CPU or D1 billing.

Initial structural comparison, each table 1,000×10 with one numeric-view index:

| Tables | JSON partial-index database | Physical database | Plain-field update VM steps: JSON / physical |
| --- | ---: | ---: | ---: |
| 2 | 2.539 MiB | 2.277 MiB | 60 / 34 |
| 10 | 8.977 MiB | 7.762 MiB | 132 / 34 |
| 30 | 25.098 MiB | 21.426 MiB | 312 / 34 |

These writes are storage-only probes, excluding full authorization/search/history transactions. VM instructions differ in cost, so 312/34 is not a ninefold user-save speedup. Global JSON expression indexes produced a 47.949 MiB database at 30 tables, with 24,000 KiB view indexes versus 600 KiB for partial indexes and physical tables. This supports rejecting all-record indexes for every business field as the default. See the [original structural data](evidence/2026-11-16-shared-records/physical-record-baseline.json).

Same-run query-service medians after D1 parameter/SQL compatibility repairs, in ms including metadata and response assembly:

| Query | JSON partial indexes | Physical |
| --- | ---: | ---: |
| 1,950×38: numeric indexed first page | 0.126 | 0.251 |
| 1,950×38: continuation | 0.145 | 0.255 |
| 1,950×38: index-provable out-of-range empty result | 2.904 | 0.115 |
| 30 tables: numeric indexed first page | 0.108 | 0.115 |

Physical empty-result queries used an extra index-probe plan absent from the JSON control, so this difference cannot be attributed entirely to storage layout. OR/unindexed cases may still scan. See [compatibility comparison](evidence/2026-11-16-shared-records/physical-query-review.json). A later physical-only improvement deferred JSON assembly until after page selection for unfiltered select sorts: the rich/wide median including UTF-8 encoding fell from 0.692 to 0.423 ms, while ordinary numeric sorting remained 0.164 → 0.163 ms. Do not combine that different run with the table above to invent a cross-layout speedup. See [attribution and optimization](evidence/2026-11-16-shared-records/physical-query-attribution.json).

Separately, the current shared candidate's 32 same-database full-pagination comparisons reduce the reproduced wide temporary select/numeric query from 3,758,012 to 277,995 VM instructions, about 92.6%. That is its own before/after query comparison, not a comparison with the physical timings. Physical storage/isolation benefits remain useful evidence, while shared records better fit current maintenance needs. Neither layout is established as stable and releasable on Free solely by these local results.
