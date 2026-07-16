# CONTEXT - paste this into a new chat to continue the project

> Copy this whole file into a new conversation so the assistant has full context.

## What this is

**Smart Fill - EZ & Inspector ADE** - the merged build of the two sibling
SmartFill Chrome MV3 side-panel extensions (folders `EZ/` and `IA/` in the
same parent directory). One extension now serves both platforms:

- **EZ** = EZ Inspections, job pages at `ezinspections.com/inspManager/*`
- **IA** = Inspector ADE, inspection modals on `inspectorade.com/orders`

The UI is EZ's (indigo SmartFill design system, light default + opt-in dark).
There is NO backend folder here - the extension POSTs to fixed remote
endpoints. The per-platform scrape/apply logic was copied VERBATIM from the
standalone extensions into `content-ez.js` / `content-ia.js`; the merge work
lives in `sidepanel.js`, `background.js`, and `manifest.json`.

Its own icon set (rounded square split diagonally EZ indigo / IA violet with a
white check) tells it apart from the standalone EZ (blue square) and IA
(violet lightning bolt) extensions when all three are loaded at once.

## Repo

`github.com/gulshanpathode-jpg/IA-EZ.git`, branch `main`. The repo root is this
`EZ-IA/` folder (the extension lives in `extension/`). `.gitignore` ignores
Markdown except `README.md` and `CONTEXT.md`. Note the standalone EZ/IA/NSR
repos gitignore their CONTEXT files, but this one is deliberately tracked for
future reference.

## The platform field (the reason this build exists)

Both platforms POST to a single shared endpoint pair; the backend tells them
apart by a `platform` field with value `"EZ"` or `"IA"`:

- Verify `POST http://101.53.137.140/ia/describe` (multipart):
  `payload` JSON is `{ platform, jobId, work_code, sections, photos }` +
  `images` files named `<photoId>.<ext>`.
- Feedback `POST http://101.53.137.140/ia/feedback` (JSON):
  `{ platform, result_id, jobId, feedback:[...] }`.

The rest of the contract is identical to the standalone extensions. URLs are
constants at the top of sidepanel.js (VERIFY_URL / FEEDBACK_URL), displayed
masked + read-only in Config.

## How the merge is wired

- **manifest.json** - two `content_scripts` entries: `imageModal.js` +
  `content-ez.js` on ezinspections.com/inspManager/*, `imageModal.js` +
  `content-ia.js` on inspectorade.com/*. Host permissions cover both sites,
  archive.inspectorade.com, and the backend host.
- **sidepanel.js** (EZ base, platform-aware):
  - `platformForUrl(url)` maps the active tab URL to `'EZ' | 'IA'` via
    `EZ_URL_RE` / `IA_URL_RE`; stored on `state.detection.platform` and, at
    sync start, `state.pipelinePlatform`.
  - `pageKeyFor` scopes retained jobs by platform (`job:EZ:<id>`), so an EZ
    work order and an IA inspection with the same number never collide. Job
    records persist `platform` (used by feedback after a panel reload).
  - Photo fetch branches per platform: EZ fetches blobs from the panel
    (resolveSourceUrl via JobPictureViewer + concurrency 5 + thumbnail
    fallback); IA sends `FETCH_IMAGES` to the content script, which fetches
    in the page origin (SameSite cookie) and returns data URLs.
  - Photo-date check branches: EZ = async `CHECK_PHOTO_DATES` with per-job
    `photoDateCache`; IA = `detection.photoDates` straight from DETECT.
    One shared `renderPhotoDates(pd, jobId, platform)` renders both (stale
    items: EZ `takenOn`, IA `imageDate`; label "Completed Date Time" vs
    "Date Completed"). `hydrateStaleThumbs` also branches (panel fetch vs
    FETCH_IMAGES).
  - Listens for both `EZ_PAGE_READY` and `ADE_PAGE_READY`.
  - Detection card shows `Job Id - <n> · EZ Inspections` or
    `Inspection ID - <n> · Inspector ADE`.
  - Storage keys are NEW: `sfVerifierConfig` / `sfVerifierJobs` (standalone
    builds used ezVerifier* / adeVerifier*), so this can be loaded alongside
    the originals.
  - EZ's `sameAnswer` (order-independent checkbox-array compare) is used for
    both platforms.
- **background.js** - `ENSURE_CONTENT_SCRIPT` message now carries
  `platform`; the file list comes from a fixed `CONTENT_FILES` map (never
  from the message payload).
- **imageModal.js** - the EZ version (a superset: accepts URL strings or
  `{ full, thumb, picture }` items and resolves EZ's true full-size image
  from the picture page). IA galleries just have `picture: ''`, which skips
  that resolver. Both content scripts call `window.EZ_IMAGE_MODAL.show`.
- Load guards differ per scraper (`__ezVerifierContentLoaded` /
  `__adeVerifierContentLoaded`) and the scripts match disjoint sites, so
  nothing double-registers.

## Invariants (do not break)

- Never rename classes/IDs that sidepanel.js references; the AI-review accent
  still uses `--purple*` variable names regardless of hue (see the sibling
  extensions' notes).
- content-ez.js / content-ia.js should stay byte-equal to their standalone
  sources (EZ/extension/content.js, IA/extension/content.js) except when a
  platform's scraper genuinely changes - port such fixes both ways.
- `platform` must be exactly `"EZ"` or `"IA"` in both verify and feedback
  payloads.

## What might be asked next

- Point VERIFY_URL / FEEDBACK_URL at the production unified backend once it
  exists (they currently target the /ia/* endpoints on the shared host).
- Port future fixes from the standalone EZ/IA extensions into the copies
  here (and vice versa).
- Possibly retire the standalone extensions once this build is proven.
