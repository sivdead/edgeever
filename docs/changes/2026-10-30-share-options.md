# Share options: custom password and page details

[简体中文](2026-10-30-share-options.zh-CN.md) · [Issue #714](https://github.com/tianma-if/edgeever/issues/714)

## Problem and outcome

Complete the two remaining user-facing parts of #714. Share owners can choose a password instead of accepting a generated value, and can hide the public page's EdgeEver/header and updated-time details. Existing shares keep their current behavior. QR PNG/SVG download is already released and is outside this change.

## Allowed changes and acceptance

1. **Custom password.** Extend the existing single-note share PATCH contract so a password-protected share can accept an explicit password in addition to the existing generated-password flow. Preserve `passwordProtected`-only clients, hashing/encryption-at-rest, unlock rate limiting, cookie invalidation, and password return behavior. Explicit passwords must be trimmed and contain 4–64 characters; reject empty, shorter, longer, or whitespace-only values without changing the share. The dialog offers generated-password and custom-password modes, shows the custom input while the owner is editing/creating it, and keeps existing authenticated password readback, regenerate, and copy behavior. Preserve `passwordProtected: false` disabling semantics without adding a combined-field rejection for an accompanying valid password. Disable custom input while saving; on failure retain the draft and original share state, display the existing error, and avoid unhandled promises. Test API compatibility, validation, hashing, replacement, old clients, and failed/pending saves.
2. **Share details toggle.** Add an additive nullable/defaulted share field whose default keeps current public-page details visible. The owner can turn details off per single-note share. The public HTML page and client renderer omit only the EdgeEver/read-only header and updated-time details when disabled; note content, title/meta behavior, Markdown endpoint, resources, password gate, slug/token, and notebook shares stay unchanged. Test old rows, both states, and password-protected/public rendering.
3. Update shared schemas/types, API rows/mappers, migration, Web/desktop share dialog, public-share presentation, and all existing locale catalogs needed by the touched UI. Use the established share components, tooltips and API error patterns. Keep the migration additive and compatible with old application binaries as far as the existing share contract allows.

Acceptance: add focused API/share-page/dialog tests before or alongside implementation; run the relevant API, shared and Web tests, then `bun run typecheck`, `bun run typecheck:mobile`, and `bun run build:web`. Exercise the actual share dialog and public page in an isolated local instance, including an existing share row, generated/custom password, invalid password, password replacement, details on/off, and the Markdown/resource paths. Record real failures and unverified native/production paths.

## Boundaries and risk

No QR download changes, notebook-share behavior, authentication redesign, backup/sync changes, unrelated sharing refactors, release/version/deployment changes, or destructive data operations. Do not modify the user's existing dirty import worktree. Do not automatically submit, merge or deploy a PR.

Worst outcomes are locking out a share through an incompatible password update or hiding metadata/content incorrectly on a public page. Rollback is reverting the application changes and leaving the additive migration in place; existing rows remain readable. The migration and old-client behavior require explicit verification. Real production Cloudflare/Docker and installed desktop acceptance are outside this local change unless separately requested.

## Completion check

Implementation and local acceptance are complete on `codex/issue-714-share-options`. No production deployment has been performed.

- Custom passwords are wired through the schema, client, share API, and Web dialog, preserving generation, encryption, authenticated readback, and copying. The details toggle uses additive migration `0082_memo_share_options.sql`, API mappings, and public-page presentation. All five locale catalogs are updated.
- Toggle/regenerate actions use the existing mutation error handling; failed custom saves retain the draft and pending saves lock the input. Injected 503 and delayed-response checks reproduced and verified the fixes with zero unhandled rejections. Disabling protection ignores an accompanying valid password, removing the combined-field rejection. The source-string-only public-page test was removed in favor of actual page acceptance.
- The [browser regression script](evidence/2026-10-30-share-options/password-controls-regression.mjs) and [results](evidence/2026-10-30-share-options/password-controls-regression.json) cover toggle, regeneration, and custom-save failures plus pending state. Inspected actual [pending](evidence/2026-10-30-share-options/review-pending.png) / [saved](evidence/2026-10-30-share-options/review-saved.png) renders. Valid evidence for the full sharing workflow and details toggles remains in [browser.json](evidence/2026-10-30-share-options/browser.json).
- Current 31 share API/Web tests, `bun run typecheck`, `bun run typecheck:mobile`, `bun run build:web`, and `git diff --check` passed; see [validation.json](evidence/2026-10-30-share-options/validation.json). Reused 41 passing shared-sharing, share-page, and notebook-share tests whose behavior is unchanged; see [related-tests.txt](evidence/2026-10-30-share-options/related-tests.txt).
- The [cross-version script](evidence/2026-10-30-share-options/cross-version.mjs) loads baseline `e052ac3b` share routes and schema, creates/unlocks a share on the old schema in real in-memory SQLite, applies migration 0082, switches to new routes, then reads/updates migrated data with old routes. [Results](evidence/2026-10-30-share-options/cross-version.json) cover unchanged old row values, pre-upgrade unlock continuity, invalidation of old passwords/cookies for body and attachments after replacement, and old-client generation/disabling. This uses unchanged current dependency modules and test object storage, not installed-application upgrade testing.

Bidirectional scope check: both features, failure handling, and compatibility have implementation and acceptance evidence. Product changes map to passwords, the details field/toggle, types, and translations. The notebook route only adds `showDetails: true` to retain its presentation. QR, authentication mechanisms, versions, and deployment configuration are unchanged.

Not verified: installed native desktop apps or production Cloudflare/Docker deployments. No mobile feature changes or Android device acceptance were performed. Apply the additive migration before deploying the new application. Rollback can leave the column in place and revert application code; baseline share routes were verified to read and update migrated data.
