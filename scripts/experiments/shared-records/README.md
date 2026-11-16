# Shared-record candidate (#787)

This local candidate follows the [maintainer's storage direction](https://github.com/tianma-if/edgeever/pull/805#issuecomment-6874868531). #805 remains limited to named views and its existing compatible optimizations. The physical-table candidate is suspended and preserved separately.

## Design and entry points

- `apps/api/src/shared-table-store.ts`: shared JSON records scoped by workspace/table, optimistic record writes, search projection, immutable record versions, fixed-revision snapshots and explicit historical/backup restoration. Ordinary edits touch only changed records. Full replacement is reserved for explicit restore.
- `apps/api/src/shared-table-index.ts`: partial expression indexes for the leading sort field of saved views, reused by field/direction/expression. Temporary queries may reuse existing indexes but create none. Views, type changes and historical restoration maintain index metadata transactionally.
- `apps/api/src/shared-table-query.ts` and `table-record-query.ts`: reuse the query compiler with scoped JSON expressions, 50-record pages and cursor revision checks. Small select prefixes reuse existing secondary-field indexes with disjoint value/position seeks; payload joins include workspace/table scope. Exact counts run only on the first filtered page; unfiltered counts come from metadata. Offline ordering uses the previously agreed Unicode scalar order.
- `apps/api/src/shared-table-type-change.ts`: strict preflight, confirmation, persisted preparation batches, table-scoped write lock, cancellation and atomic publication. Old values remain readable while preparation runs. Each historical revision retains its original fields and cell values, including across field types.
- `table-query-sql.ts` and `table-query-contains.ts`: lossless accepted UTF-16 values/identities at the native SQL boundary and existing JavaScript contains semantics for surrogate-boundary needles. Normal needles retain instr; special matching checks byte-aligned UTF-8/WTF-8 boundaries. Literal anchors stay in instr so GLOB patterns remain below D1's 50-byte limit even for long needles.
- `schema.sql`: explicit experimental schema; production migrations and startup do not load it. The number of shared tables does not grow with logical table count. Saved-field indexes do grow, so their write and space costs remain part of acceptance.
- `routes.ts`: local HTTP harness reusing existing scope checks. It is never imported by the production API entry point.

The service uses the existing `DatabaseAdapter` without Cloudflare SDK calls or extra dependencies. `initialize` explicitly imports a complete legacy document locally; it is not a resumable production migration. `serializeSharedTableSnapshot` preserves nulls using the earlier `nullable-v1` marker; ordinary serialization and unmarked legacy input retain their existing behavior.

## Run locally

From the candidate repository root with existing dependencies available:

```sh
bun test apps/api/src/table-query-contains.test.mjs apps/api/src/shared-table-review.integration.test.mjs apps/api/src/shared-table-query-budget.test.mjs apps/api/src/shared-table-store.integration.test.mjs packages/shared/src/table-conversion.test.mjs packages/shared/src/table.test.mjs
bun scripts/experiments/shared-records/verify.mjs test-results/shared-records-run
bun run typecheck
bun run typecheck:mobile
bun run build:web
```

The verification driver requires a fresh output directory and Python 3 with SQLite FTS5. The D1 limit regressions additionally use Python 3.11+ `Connection.setlimit`. Only local synthetic databases are used: 2/10/30 tables of 1,000×10 and two rich-text tables of 1,950×38. Checks cover complete results, page payload size, exact-count frequency, first/last-table isolation, plans, database/object size and the work of a single-record write. Python replays captured SQL against an in-memory copy of the database captured **before** that write; no evidence database is modified by replay.

SQLite VM instructions, SQLite change events and adapter-returned rows are distinct from D1 billed reads/writes. Single local timing samples do not establish latency or Workers CPU guarantees. The [acceptance summary](../../../docs/changes/evidence/2026-11-16-shared-records/summary.json) records code fingerprints and the measured boundary.

## Remaining product gates

The reproduced small-select/numeric mixed case uses existing indexes: complete wide-table VM work falls from 3,758,012 to 277,995 on the same database with current lossless ID reads. See [current review acceptance](../../../docs/changes/evidence/2026-11-16-shared-records/review-loop.json); the earlier query-optimization evidence is a historical baseline. Larger option sets and arbitrary continuous-value sorts without a suitable index retain their previous path; they are not claimed as optimized. No broader indexing, caching or new rejection rule is introduced.

For an exact comparison against an earlier verification output containing `*-before.sqlite` and captured query JSON, run:

```sh
bun scripts/experiments/shared-records/compare-queries.mjs <baseline-output> <comparison-output>
```

The comparison opens existing databases read-only and replays old/new SQL against the same data. An `EXPLAIN` temporary sort over at most 51 candidates is different from repeatedly sorting all table records.

Production automatic migration, offline queues, all public-form and resource-write paths, default backup entry points, native upgrades and rollback are not switched to this candidate. The ZIP test covers a small table with cross-type histories and attachment bytes; it does not establish near-limit large-archive restoration. Existing ZIP limits remain. Cloud D1 billing and Workers Free CPU require separate authorized validation; this iteration makes no cloud requests.
