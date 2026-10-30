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

No QR download changes, notebook-share behavior, authentication redesign, backup/sync changes, unrelated sharing refactors, release/version/deployment changes, or destructive data operations.

Worst outcomes are locking out a share through an incompatible password update or hiding metadata/content incorrectly on a public page. Rollback is reverting the application changes and leaving the additive migration in place; existing rows remain readable. The migration and old-client behavior require explicit verification. Real production Cloudflare/Docker and installed desktop acceptance are outside this local change unless separately requested.

## Completion check

Both features are implemented. Custom passwords retain the existing encryption, rate limiting, and unlock invalidation mechanisms. Migration `0082_memo_share_options.sql` adds the details setting with visibility on by default. Notebook pages retain their presentation; QR downloads and deployment configuration are unchanged.

- 31 share API/Web tests and 4 share-menu tests passed, along with type checking, mobile type checking, the Web build, and diff checks; see [validation results](evidence/2026-10-30-share-options/validation.json) and [menu tests](evidence/2026-10-30-share-options/menu-tests.txt). Results from 41 related tests whose behavior is unchanged remain valid.
- Exercised password setting/replacement/disabling, public-page header visibility, Markdown access, failure-state and draft retention, and disabled pending input. See [browser acceptance](evidence/2026-10-30-share-options/browser.json), the [failure/pending regression](evidence/2026-10-30-share-options/password-controls-regression.mjs), and its [results](evidence/2026-10-30-share-options/password-controls-regression.json). Actual captures: [pending](evidence/2026-10-30-share-options/review-pending.png), [saved](evidence/2026-10-30-share-options/review-saved.png), [header shown](evidence/2026-10-30-share-options/details-visible.png), and [header hidden](evidence/2026-10-30-share-options/details-hidden.png).
- [Cross-version acceptance](evidence/2026-10-30-share-options/cross-version.mjs) covers baseline `e052ac3b` share routes/schema → SQLite migration 0082 → new routes → baseline route read/update. It verifies preserved old rows, pre-upgrade unlock continuity, and invalidation of old passwords/cookies for body and attachments after replacement. It uses test object storage and validates API/database compatibility, not installed-application upgrades.

Full Ubuntu regression is not passing: the existing upstream assertion in `PreferenceCard.test.mjs:31` conflicts with upstream monospace code-font support. The upstream font-change maintainer needs to align that test and rerun CI. This change does not modify the font implementation or that test.

Installed native desktop apps and production Cloudflare/Docker deployments are unverified; no mobile feature changes are included. Apply the additive migration before deploying the application. Rollback can retain the column and revert application code; baseline share-route read/update compatibility was verified.
