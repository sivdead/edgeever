# Document outline for read-only share pages

## Problem and goal

Issue #775 requests an editor-like document outline for Web read-only share pages: show headings as a hierarchy, jump to a section when a heading is selected, and keep “Collapse all headings” and “Expand all headings”. The ordinary `/share/:token` page has no outline today; the public notebook site already has a basic outline but lacks bulk collapse controls.

## Allowed changes

- Reuse one read-only document outline for ordinary share pages and public notebook sites. Build a tree from rendered H1–H4 headings, support smooth navigation, and highlight the active section.
- Show the outline in a desktop right rail and provide a mobile drawer entry point. Render no outline entry when the document has no headings.
- Add “Collapse all headings” and “Expand all headings”. These controls only change the visible outline tree; they do not collapse the document body, and the state is not written to the note or server.
- Preserve existing share content rendering, heading-anchor navigation, image preview, site search, and backlink preview behavior.
- Add the smallest automated checks covering heading hierarchy and bulk-collapse parent selection, then run the affected Web checks.

## Boundaries that stay unchanged

- Do not change the share API, token, authentication, password unlock, or body data structures.
- Do not change the editor `EditorOutline` persistence or editing interactions.
- Do not extend beyond H4; keep the H1–H4 navigation contract already used by public notebook sites.
- Do not commit, push, merge, or deploy. This task delivers the implementation and evidence in the independent worktree only.

## Completion check

- Implemented the shared read-only outline and wired it into both share layouts.
- Added pure hierarchy/parent-selection tests; both pass.
- `oxlint` passes for the changed TypeScript files.
- Full typecheck and Web build remain blocked by the checkout's incomplete dependency state and pre-existing project errors; no errors were reported for the new outline files.
