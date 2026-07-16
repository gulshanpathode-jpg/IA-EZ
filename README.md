# Smart Fill - EZ & Inspector ADE

One Chrome MV3 side-panel extension that works on both inspection platforms:

- **EZ Inspections** - job pages at `ezinspections.com/inspManager/...`
- **Inspector ADE** - inspection modals at `inspectorade.com/orders` (Approve/Reject tab)

It is the merge of the two sibling SmartFill extensions (EZ and IA) into a
single build, using the EZ design system for the UI. There is no backend in
this repo - the extension POSTs to a fixed remote endpoint.

## What it does

1. Auto-detects a supported inspection page in the active tab and works out
   which platform it belongs to from the URL.
2. **Sync & Verify with AI** scrapes sections / questions / current answers
   plus labeled photos, fetches the photo images, and POSTs everything as
   `multipart/form-data` to the verify backend.
3. The backend returns a suggested answer per question; the panel builds a
   review queue of **Accept / Reject / Reconsider** cards with
   **All / Different / Matched** filters. Accept writes the AI answer back
   into the live page.
4. **Send Feedback** posts the operator's decisions back to the backend
   (also auto-sent on reset and on panel close).

Photo-date checking, address actions (copy / Google / Maps), per-job result
retention (15 jobs), persistence across panel reloads, activity log, light and
dark themes, and the on-page image viewer all work on both platforms.

## The platform field

Both platforms POST to the **same** endpoint pair. The backend tells them
apart by a `platform` field:

- Verify (`POST /ia/test/describe`, multipart): the `payload` JSON is
  `{ platform: "EZ" | "IA", jobId, work_code, sections, photos }` plus the
  binary `images` files named `<photoId>.<ext>`.
- Feedback (`POST /ia/test/feedback`, JSON):
  `{ platform: "EZ" | "IA", result_id, jobId, feedback: [...] }`.

Everything else in the contract is unchanged from the standalone extensions.
The URLs are constants at the top of `extension/sidepanel.js` (`VERIFY_URL`,
`FEEDBACK_URL`) and are shown masked and read-only in the Config tab.

## How the merge works

| Piece | EZ | IA |
| --- | --- | --- |
| Scraper | `content-ez.js` (WebForms job page) | `content-ia.js` (orders modal) |
| Photo fetch | from the panel (CORS-exempt, cookie rides along) | in the page origin via `FETCH_IMAGES` (SameSite cookie) |
| Photo-date check | async `CHECK_PHOTO_DATES` message, cached per job | returned inline by `DETECT` as `photoDates` |
| Ready signal | `EZ_PAGE_READY` | `ADE_PAGE_READY` |

The manifest declares one `content_scripts` entry per site, so only the right
scraper loads on each page. `imageModal.js` (the on-page viewer) is shared.
The side panel (`sidepanel.js`) is platform-aware: it derives the platform
from the tab URL, tags payloads with it, scopes retained jobs by it
(`job:EZ:<id>` vs `job:IA:<id>`), and picks the right photo strategy per run.

Both content scripts answer the same core messages (`DETECT`, `SCRAPE`,
`APPLY_ANSWER`, `FOCUS_QUESTION`, `SHOW_IMAGE_MODAL`, `PING`), so the rest of
the panel does not care which site it is talking to.

## Files

```
extension/
  manifest.json    # MV3; both sites' host permissions; one content_scripts
                   #   block per platform
  background.js    # opens the side panel; on-demand injection resolves the
                   #   file list from the platform the panel names
  imageModal.js    # shared on-page image viewer (zoom/pan/prev-next)
  content-ez.js    # EZ scraper + apply + photo-date check
  content-ia.js    # IA scraper + apply + page-origin image fetch
  sidepanel.html   # EZ SmartFill layout (rail, detection, status, queue, config)
  sidepanel.css    # EZ design system (indigo identity, light + dark)
  sidepanel.js     # platform-aware controller
  theme-init.js    # applies the saved theme before first paint
  icons/           # own icon set - a rounded square split diagonally between
                   #   the EZ indigo and IA violet with a white check, so it is
                   #   easy to tell apart from the standalone EZ / IA icons
```

## Install

1. Open `chrome://extensions`, enable Developer mode.
2. **Load unpacked** and select the `extension/` folder.
3. Open an inspection on either site and click the toolbar icon.

Storage keys (`sfVerifierConfig`, `sfVerifierJobs`) are new, so this build can
be loaded alongside the standalone EZ and IA extensions without clobbering
their saved state - but running two panels against the same page at once is
not recommended.
