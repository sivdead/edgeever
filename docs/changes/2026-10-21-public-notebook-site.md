# Issue 591 public notebook site change checklist

[简体中文](2026-10-21-public-notebook-site.zh-CN.md)

Authorization: the user requested a new branch, a plan commit, and implementation of that plan. See the [site plan](../public-notebook-site-plan.md). Branch `feat/public-notebook-site-591` starts at official `5d1a0661`; plan commit `ac3e02d1`. There were no other uncommitted changes before implementation.

## Problem and objective

The site lacks body search, per-note exclusions, homepage selection, and branding settings. Implement R01–R13 using explicit exclusions scoped to each share, without using tags as draft status. Improve reading, discovery, content selection, and site presentation.

Scope includes public Web reading, author share settings, shared API/client types, an additive database migration, and Cloudflare/Docker page entries. The worst outcome is disclosure of excluded notes or protected information. Once exclusions are enabled, rollback must retain filtering or revoke affected shares before using an older server. Remote migration, deployment, actual search-engine indexing, and social crawlers are outside local acceptance.

## Allowed changes and acceptance

| ID | Allowed behavior | Acceptance |
| --- | --- | --- |
| C01 | Add the next migration: nullable share `site_slug`, valid-object JSON defaulting to `{}`, and case-insensitive alias uniqueness. Add an exclusion relation with two foreign keys, composite primary key, and physical-delete cascades. Legacy shares start without exclusions. | Upgrade old data with real tokens/passwords, read/unlock existing shares, and verify defaults, collisions, and cascades. |
| C02 | Share settings expose alias, homepage, HTTPS logo, HTTPS header links, plain-text footer, indexing, and existing/title ordering. Accept only the six settings keys; merged JSON is at most 16 KiB. Empty aliases clear; others normalize to lowercase letters/digits/hyphens. Reject invalid URLs, ordering, homepages, and unknown keys. Explicit homepages must be visible; invalid stored references fall back on reads. | API management and real UI saves followed by anonymous readback, invalid inputs, partial writes, and invalidated homepages. |
| C03 | Authors can paginate exclusions and exclude/restore notes. Operations require user identity and an active share in the current workspace; setting an exclusion also requires a live subtree note, while restoring deletes only this share's relation. Both operations are idempotent. Moves/soft deletion retain exclusions; restored notes remain excluded. Recreated shares do not inherit exclusions. | Actual Hono routes covering authorization, independent child shares, moves/restores, deletion, and revocation. |
| C04 | Directory, article, resources, link resolution, search, preview, homepage, and metadata share live-scope/exclusion checks. Tags remain classification/search metadata. Filter before pagination using existing FTS, Chinese substring matching, and pagination limits; return body excerpts/highlights. Preview returns only visible note titles and existing short excerpts. | API-to-database/resource readback covering disclosure, Chinese/body hits, pagination, combined tags, preview, and password gates. |
| C05 | Visitors get a shortcut search dialog, highlights/excerpts, tag filtering, pagination, and retry feedback. Keep directory access alongside custom homepages. Apply natural title/number ordering consistently to navigation, contents, and previous/next. | Real author-to-anonymous-page flow. |
| C06 | Add H1–H4 outlines, duplicate-safe anchors, scrollspy, smooth navigation, and fragment reloads. Support mobile drawers, keyboards, and reduced motion. | Long-article anchors, reload, scroll, mobile viewport, and keyboard checks. |
| C07 | Notebook sites reuse local light/dark/system preference across article/code/diagrams. Code shows language, full-source copying, and collapse; images open a lightbox on click with gesture zoom; reuse diagram fitting/fullscreen. | Actual article/code/image/diagram interactions; preserve individual-note sharing behavior. |
| C08 | Internal links show on-demand HoverCard previews on hover/focus. Use Tooltip instead of native title. Invalid/excluded targets disclose no titles/excerpts or independent-share bypasses. | Actual hover/focus, rejected APIs, and filtered links. |
| C09 | Logo failures fall back to the current icon; render header links/footer. `/s/:slug/:memoId?` resolves only the token and reuses canonical links, password cookies, and revocation. | Canonical/alias links, unlocking, collisions, and invalidated access. |
| C10 | Indexing defaults off and requires no password plus explicit opt-in. Render server HTML head/canonical/OG/Twitter; protected pages remain generic. Invalid/excluded articles return unavailable status and noindex. Preserve private/no-store and no-referrer; JSON APIs always remain noindex. Setting/rotating passwords disables indexing; clearing does not re-enable it. Reject enabling indexing with a password. | Raw HTML/headers, escaping, password changes, privacy, and the shared page service through Cloudflare/Docker entries. |

## Boundaries retained

- Keep global note states, tag semantics, content, sync, author hierarchy, and notebook order. Preserve individual-note-share and public-form access rules.
- Preserve tokens, password hashes/ciphertext/encryption roots, cookie paths, and password-only operations; settings saves do not rotate passwords.
- No drag ordering, review/scheduling, publication snapshots, complete article SSR, sitemap, asset uploads, or screenshot service.
- Reuse the current 30-second refresh and invalidation handling; no new polling, event bus, or cache. No promise to recall downloaded content or immediately remove external indexes.
- Share business logic across Cloudflare/Docker with thin static-template/infrastructure entries. Do not change native apps, desktop runtimes, versions, release/deployment workflows, or dependencies.
- No push, deployment, or release. Current authorization covers local plan commit and implementation.

## Implementation and completion audit

R01–R13 are implemented, with C01–C10 checked in both directions against the actual diff. There are no feature changes outside the checklist. Historical ablation scripts/results remain unchanged and do not count as product tests.

| Checklist | Implementation and acceptance evidence |
| --- | --- |
| C01 | Only migration `0072`: two columns, one two-column exclusion table, and indexes. Actual `5d1a0661` routes with migrations `0001`–`0071` created legacy data, a hashed password, and an unlock cookie. After migration, new routes retained the original URL, hash, and working cookie. Route tests cover defaults, collisions, cascades, and recreation. |
| C02 | Shared strict schema, database-side `json_patch`, and a UTF-8 byte limit. Real author UI saves were read back through anonymous directory/page requests. Route tests cover invalid inputs, partial writes, invalidated homepages, and preserving passwords on settings saves. |
| C03–C04 | Shared `publicTreeSql` / `visible_memos` enforce scope. Route tests cover exclusions/restores, resources, links, homepages, metadata, search, previews, pagination, Chinese/combined tags, workspace boundaries, and independent child shares. |
| C05 | Browser flow covered settings, alias homepage, directory, and natural numeric ordering. Shortcut search found a body-only keyword and displayed highlighted excerpts; closing restored focus. Actual API tests cover tag filtering, pagination, and access denials. |
| C06 | Long articles verified H1–H4, duplicate anchors, fragment reloads, scrollspy, and sticky headers. A 390 CSS-pixel viewport verified chapter/outline drawers, heading navigation, and no horizontal overflow. |
| C07 | Browser checks covered actual light/dark colors, copy feedback, collapse/expand, image lightbox opening, and fitting/fullscreen/Escape on the same diagram. System theme was restored. Mermaid, properties, and lightbox zoom reuse existing components; physical-device gestures were not separately accepted. |
| C08 | Real hover and keyboard focus displayed previews. API tests denied excluded previews; article links resolve only currently visible site targets. |
| C09–C10 | Actual requests through local Cloudflare Worker and self-hosted Bun entries covered alias HTML, canonical URLs, escaping, indexing headers, excluded article 404, and revocation. Password pages remained generic; setting a password disabled indexing and clearing it left indexing off. The browser also verified failed-logo fallback, header links, and footer. |

Checks:

- `bun test apps/api/src/notebook-share-routes.test.mjs apps/web/src/lib/public-share-body.test.mjs packages/shared/src/sharing.test.mjs packages/shared/src/i18n/catalog.test.mjs`: 38 passed.
- `bun test tests/deployment-entrypoints.test.ts`: 21 passed. Updated the existing configuration fingerprint for the Cloudflare route change; instance-specific configuration rejection remains in place, without changing deployment mechanisms.
- `bun run typecheck`, `bun run typecheck:mobile`, and `bun run build:web`: all passed. Targeted lint of changed files and `git diff --check` passed.
- Reviewed React structure, Hooks, keyboard/focus handling, and types. No dependencies, versions, or native runtimes changed.

Acceptance covers local Cloudflare/D1 and the actual self-hosted entry, not a Docker container build/run, remote migrations, production deployment, real search/social crawlers, concurrency races, or Android/iOS devices. Articles retain SPA rendering without complete SSR or sitemap; these checks do not establish indexing outcomes. Local logs and screenshots remain at `/tmp/edgeever-591-*`.

Delivery consists of a local branch with separate plan and implementation commits. Nothing has been pushed, deployed, or released. Rollback after exclusions are enabled still requires the visibility safeguards described above.
