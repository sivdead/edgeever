# Issue 701: restore resource XSS protection

[简体中文](2026-10-28-restore-resource-xss.zh-CN.md)

## Problem and outcome

[Issue #701](https://github.com/tianma-if/edgeever/issues/701) reports that restore accepts `kind=image` with `mimeType=text/html`, while resource responses trust `kind` to enable inline rendering. Close both the write-time mismatch and the read-time exposure of previously stored resources. Work starts from official `main` at `b8496806` in a separate worktree.

The change affects API resource restore and resource response headers shared by Cloudflare and Docker. Backups explicitly labeling an image as an incompatible type such as HTML are rejected; valid old backups must still restore. The existing nullable MIME contract and unknown/binary fallback remain supported, with unknown types downloading instead of rendering inline. HTML and other arbitrary attachments remain downloadable. There is no migration or deletion of existing data. Rollback reverts the code without rewriting resources; reverting also reintroduces the vulnerability. Native-platform runtime and deployment acceptance are separate from the local checks below.

The backup schema explicitly permits null MIME, the released exporter preserves it, and resumable restore already falls back to `application/octet-stream`. Rejecting that safe fallback would break legitimate old archives without contributing to XSS protection; response-time MIME checks provide the download boundary.

Compare image MIME case-insensitively without parameters, but retain the stored MIME and its parameters as before. Stripping parameters from the stored value is unnecessary for validation and would discard encoding information such as SVG `charset`.

## Allowed changes and acceptance

| ID | Behavior | Acceptance |
| --- | --- | --- |
| S1 | Legacy restore and resumable restore initialization/completion validate the effective MIME of resources marked `image` against the existing PNG/JPEG/GIF/WebP/AVIF/SVG allowlist, while preserving empty/unspecified and `application/octet-stream` MIME accepted by the original restore contract. Explicit incompatible types return the existing `415 unsupported_media_type` error. Legacy restore includes the existing uploaded-file MIME fallback when metadata MIME is null. Image MIME comparison ignores casing and parameters without rewriting stored MIME metadata or parameters; non-image attachment MIME metadata and size limits keep their existing contracts. | First add failing isolated API regressions for explicit HTML/XHTML, null metadata with an HTML file type, and multipart restore including an upload session created before the fix. Assert rejection without a new resource/object, preserving existing resources. Verify empty/null/binary image MIME still restores through both APIs and downloads; include null MIME in the released-exporter archive fixture. Preserve SVG encoding parameters and bytes through both restore paths. |
| S2 | Authenticated, public-note and public-notebook blob responses only use the image-specific inline branch when the effective response MIME is allowlisted. Existing malformed resources, including a null database MIME falling back to HTML object metadata, download instead. PDF/audio/video preview rules still use database MIME and filename, not object-metadata fallbacks; `nosniff`, SVG sandbox CSP, range handling and access checks stay unchanged. | Seed isolated legacy rows and verify the real response headers through all three routes, including storage-metadata fallback and SVG/PDF/media previews. Untyped binary attachments must not gain inline previews solely from PDF/media object metadata. |
| S3 | Add only regressions and compatibility evidence needed for S1/S2. | Verify rejection and ordinary restore through the actual app/database/blob adapter; restore a valid archive produced by the previous released implementation, preserving note/resource data and bytes. Run affected tests, `bun run typecheck`, `bun run typecheck:mobile` and `bun run build:web`. |

## Unchanged boundaries

- No backup-format, schema, migration, authentication, API-token, permission, upload-size, retry or fallback changes beyond S1/S2.
- Do not forbid HTML attachments, sanitize stored note bodies, delete existing resources, or operate on another user's instance/data.
- Deliver through a focused commit and contribution branch, with an upstream PR linked to #701. No automatic merge, deployment or release. Keep the original #657 checkout and its uncommitted changes untouched.

## Completion check

- S1: legacy restore, multipart initialization and persisted-session completion reject explicitly incompatible image MIME with `415 unsupported_media_type`; rejected replacement preserves the original resource and bytes, and completion rejects before object assembly. Null/empty/binary MIME, the valid legacy file-MIME fallback, and SVG encoding parameters/bytes survive both restore paths.
- S2: actual authenticated, public-note and public-notebook routes download historical HTML/XHTML image rows, including object-metadata fallback. Untyped attachments with PDF/audio/video object metadata remain downloads. Existing PDF/audio/video range previews, access controls and SVG sandbox checks pass.
- S3: 113 distinct affected tests pass: 26 security/compatibility regressions plus 87 existing archive/resource/share tests (reusing applicable checks). The frozen [v2.12.0 fixture](../../tests/fixtures/restore-resource-security/README.md), produced by the released exporter at `eeaab088`, includes a null-MIME image and restores through both real HTTP API paths; notebook/note/revision data, attachment bytes and unrelated notes are checked.
- Latest `bun run typecheck`, affected-file oxlint and `git diff --check` pass. Previous passing `bun run typecheck:mobile` and `bun run build:web` remain applicable; this review changed only API code, its regressions and documentation/fixtures.
- Review closed three compatibility findings: rejecting safe unknown image MIME, discarding stored MIME parameters, and expanding PDF/media previews from object metadata. Removed MIME rewriting; one shared disposition helper still serves both resource response implementations. Latest correctness, simplification and design-boundary review has no unresolved substantive findings.
- Bidirectional scope check: the five modified API modules implement S1/S2; the new regression test, released-archive fixture and bilingual records implement S3. No schema, migration, package, dependency or other behavior changes.
- No deployment, live Cloudflare/R2 acceptance or native-platform runtime verification was performed. The original #657 working files were not edited.
