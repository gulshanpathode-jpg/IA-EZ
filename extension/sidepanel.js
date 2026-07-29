/**
 * sidepanel/sidepanel.js - Controller for the Smart Fill AI Verifier panel.
 *
 * One panel, two platforms: EZ Inspections (ezinspections.com job pages) and
 * Inspector ADE (inspectorade.com inspection modals). Three rail tabs: Home
 * (Sync), Activity, Config. The Home tab auto-detects a supported page, works
 * out which platform it belongs to from the tab URL, and drives a single
 * pipeline:
 *
 *   Sync & Verify → SCRAPE (the platform's content script) → fetch photo blobs
 *   → POST multipart to the shared verify backend (payload tagged with
 *   platform: "EZ" | "IA") → build a review queue of Accept / Reject /
 *   Reconsider cards, filterable by All / Different / Matched.
 *
 * The data layer (scrape / apply) is platform-specific and lives in
 * content-ez.js / content-ia.js; both answer the same messages (DETECT,
 * SCRAPE, APPLY_ANSWER, FOCUS_QUESTION, SHOW_IMAGE_MODAL). The look & feel is
 * the EZ SmartFill design system.
 */

'use strict';

// ═════════════════════════════════════════════════════════════════════
// 1. DOM cache
// ═════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const els = {
  // Detection
  detectionCard: $('detection-card'),
  detectionLabel: $('detection-label'),
  detectionName: $('detection-name'),
  detectionBadge: $('detection-badge'),
  detectionAddressBlock: $('detection-address-block'),
  detectionAddress: $('detection-address'),
  detectionPhotoDatesBlock: $('detection-photodates-block'),
  photoDatesFlag: $('photodates-flag'),
  btnCopyAddress: $('btn-copy-address'),
  btnOpenAddress: $('btn-open-address'),
  btnMapAddress: $('btn-map-address'),

  // Status canvas
  statusBadge: $('status-badge'),
  statusDesc: $('status-desc'),
  canvasTitle: $('canvas-title'),
  canvasSubtitle: $('canvas-subtitle'),
  canvasRing: $('canvas-ring'),
  ringProgress: $('ring-progress'),
  canvasProgressLabel: $('canvas-progress-label'),
  btnSync: $('btn-sync'),
  btnRefresh: $('btn-refresh'),

  // Queue
  queueCard: $('queue-card'),
  queueHeading: $('queue-heading'),
  countPending: $('count-pending'),
  countAccepted: $('count-accepted'),
  countRejected: $('count-rejected'),
  btnAcceptAll: $('btn-accept-all'),
  btnRejectAll: $('btn-reject-all'),
  suggestionList: $('suggestion-list'),
  btnSendFeedback: $('btn-send-feedback'),
  filterCountAll: $('filter-count-all'),
  filterCountDifferent: $('filter-count-different'),
  filterCountMatched: $('filter-count-matched'),

  // Warning
  warningCard: $('warning-card'),
  warningBody: $('warning-body'),

  // Shared chrome
  activityList: $('activity-list'),
  btnClearLog: $('btn-clear-log'),
  connDot: $('conn-dot'),
  connText: $('conn-text'),
  toast: $('toast'),

  // Config
  cfgVerifyUrl: $('cfg-verify-url'),
  cfgFeedbackUrl: $('cfg-feedback-url'),
  cfgFullRes: $('cfg-fullres'),
  cfgDark: $('cfg-dark'),
  cfgColorCurrent: $('cfg-color-current'),
  cfgColorImage: $('cfg-color-image'),
  swatchCurrent: $('swatch-current'),
  swatchImage: $('swatch-image'),
};

// ═════════════════════════════════════════════════════════════════════
// 2. State + constants
// ═════════════════════════════════════════════════════════════════════

// ── Fixed backend endpoints ──────────────────────────────────────────
// The verify + feedback URLs are CONSTANT and NOT user-editable. They are the
// single source of truth for where the extension talks to the AI backend.
// BOTH platforms POST to the same pair - the backend tells EZ and IA apart by
// the "platform" field in the payload. The Config tab only DISPLAYS them
// (masked), it cannot change them.
const VERIFY_URL = 'http://101.53.137.140/ia/describe';
const FEEDBACK_URL = 'http://101.53.137.140/ia/feedback';
const COLOR_DEFAULTS = { current: '#f6f7fb', image: '#fbe9fe' };
const COLOR_VARS = { current: '--cfg-current-bg', image: '--cfg-image-bg' };
const STORAGE_KEY = 'sfVerifierConfig';
const STORAGE_JOBS_KEY = 'sfVerifierJobs'; // persisted review queues + decisions

const state = {
  detection: null,       // { supported, jobId, url, questionCount, photoCount, title }
  pipeline: 'idle',      // idle | scraping | uploading | analyzing | complete | error
  scraped: null,         // active job's SCRAPE result
  photoBlobUrls: {},     // active job's attid → object URL (thumbnails)
  entries: [],           // active job's review-queue entries
  resultId: '',          // active job's verify result_id (sent back with feedback)
  feedbackSent: false,   // true once this job's feedback was sent (button greys out)
  resultsByJob: {},      // jobKey → { jobKey, jobId, resultId, feedbackSent, entries, scraped, photoBlobUrls }
  jobOrder: [],          // insertion order of jobKeys (for the eviction cap)
  filter: 'all',         // all | different | matched
  lastPhotoStats: null,  // { total, ok } from the last sync (end-of-sync summary)
  apiStartMs: 0,
  pipelinePageKey: null, // job-id key the current queue belongs to (see pageKeyFor)
  pipelinePlatform: null, // "EZ" | "IA" - platform the current run belongs to
  activity: [],
  config: { fullRes: true, theme: 'light', colors: { ...COLOR_DEFAULTS } },
};

const STATUS_DESCRIPTIONS = {
  idle: 'Open an EZ Inspections or Inspector ADE page to begin.',
  ready: 'Ready to sync the current job.',
  scraping: 'Reading questions from the page…',
  uploading: 'Fetching photos and uploading…',
  analyzing: 'Matching AI answers to questions…',
  complete: 'AI analysis complete. Review answers below.',
  error: 'Something went wrong - see details below.',
  unsupported: 'SmartFill works on EZ Inspections and Inspector ADE pages - open one to begin.',
};

// ═════════════════════════════════════════════════════════════════════
// 3. Shared helpers
// ═════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function norm(v) {
  return (v == null ? '' : String(v)).trim().toLowerCase();
}

// Compare two answers for equality. Checkbox answers are arrays (a SET of
// selected labels): compare them order-independently so ["A","B"] equals
// ["B","A"]. Scalars fall back to normalised string comparison.
function sameAnswer(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const setA = new Set((Array.isArray(a) ? a : [a]).map(norm));
    const setB = new Set((Array.isArray(b) ? b : [b]).map(norm));
    if (setA.size !== setB.size) return false;
    for (const v of setA) if (!setB.has(v)) return false;
    return true;
  }
  return norm(a) === norm(b);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Stable identity for a detected page. Prefer the platform-scoped job id - it
// survives postbacks that can mutate the URL, and the platform prefix keeps an
// EZ work order and an IA inspection that happen to share a number apart.
// Fall back to the URL.
function pageKeyFor(d) {
  if (!d) return null;
  if (d.jobId) return 'job:' + (d.platform || 'EZ') + ':' + d.jobId;
  if (d.url) return 'url:' + d.url;
  return null;
}

function setConnection(stateName /* idle|online|error */, text) {
  els.connDot.className =
    'conn-dot ' + (stateName === 'online' ? 'is-online' : stateName === 'error' ? 'is-error' : '');
  els.connText.textContent = text;
}

function showToast(message, ms = 2200) {
  els.toast.textContent = message;
  els.toast.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('is-visible'), ms);
}

function logActivity(message, level = 'info') {
  state.activity.unshift({ ts: new Date(), message, level });
  if (state.activity.length > 200) state.activity.pop();
  renderActivity();
}

// Resolve the active tab and message its content script.
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// ── Platforms ────────────────────────────────────────────────────────
// The pages each platform's content script is allowed to run on. A tab's URL
// decides which platform it belongs to - and with it the scraper to inject,
// the id label on the detection card, and the photo-fetch strategy.
const EZ_URL_RE = /^https?:\/\/(www\.)?ezinspections\.com\/inspManager\//i;
const IA_URL_RE = /^https?:\/\/(www\.)?inspectorade\.com\//i;

const PLATFORM_LABELS = { EZ: 'EZ Inspections', IA: 'Inspector ADE' };
const PLATFORM_ID_LABELS = { EZ: 'Job Id', IA: 'Inspection ID' };

function platformForUrl(url) {
  if (EZ_URL_RE.test(url || '')) return 'EZ';
  if (IA_URL_RE.test(url || '')) return 'IA';
  return null;
}

// Ask the service worker to inject the tab's platform scraper on demand.
// Returns true on success. Skips unsupported tabs (executeScript would fail
// outside our host permissions anyway).
async function ensureContentScript(tab) {
  const platform = platformForUrl(tab && tab.url);
  if (!tab || tab.id == null || !platform) return false;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ENSURE_CONTENT_SCRIPT',
      tabId: tab.id,
      platform,
    });
    return !!(res && res.ok);
  } catch (e) {
    return false;
  }
}

// Message a tab's content script. If it isn't there yet (e.g. the page was open
// before the extension loaded), inject it on demand and retry once - so the user
// never has to reload the page first.
async function messageTab(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    const injected = await ensureContentScript(tab);
    if (!injected) throw e;
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

async function sendToTab(message) {
  const tab = await activeTab();
  if (!tab) throw new Error('No active tab');
  return await messageTab(tab, message);
}

// ═════════════════════════════════════════════════════════════════════
// 4. Tab navigation (rail)
// ═════════════════════════════════════════════════════════════════════

document.querySelectorAll('.rail-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const id = tab.dataset.tab;
    document.querySelectorAll('.rail-tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('is-active', p.dataset.panel === id);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// 5. Detection
// ═════════════════════════════════════════════════════════════════════

async function detect() {
  els.detectionName.textContent = 'Checking…';
  els.detectionBadge.textContent = 'DETECTING';
  els.detectionBadge.className = 'badge badge-idle';

  const tab = await activeTab();
  const platform = platformForUrl(tab && tab.url);
  let res = null;
  if (tab && platform) {
    try {
      // messageTab injects the platform's scraper on demand if it isn't already
      // running, so a never-reloaded page still detects without a refresh.
      res = await messageTab(tab, { type: 'DETECT' });
    } catch (e) {
      res = null; // injection blocked, or the page is still loading
    }
  }

  if (res && res.ok && res.supported) {
    state.detection = { ...res, platform, title: tab ? tab.title : '' };
  } else {
    state.detection = { supported: false, url: tab ? tab.url : '', title: tab ? tab.title : '' };
  }

  renderDetection();

  // Warm the photo cache in the background so clicking Sync skips the photo
  // phase. Runs once per job (TTL-guarded); best-effort, never blocks detect.
  if (state.detection.supported) schedulePrefetch(state.detection, tab);
}

function renderDetection() {
  const d = state.detection;
  const supported = !!(d && d.supported);
  // A sync in progress owns the status canvas - a stray re-detect (e.g. a tab
  // switch mid-run) must not overwrite the live progress UI.
  const working =
    state.pipeline === 'scraping' ||
    state.pipeline === 'uploading' ||
    state.pipeline === 'analyzing';

  // ── Detection card (always reflects the active tab) ──────────────
  if (supported) {
    const idLabel = PLATFORM_ID_LABELS[d.platform] || 'Job Id';
    const siteLabel = PLATFORM_LABELS[d.platform] || 'Inspection';
    els.detectionName.textContent = d.jobId
      ? `${idLabel} - ${d.jobId} · ${siteLabel}`
      : `${siteLabel} inspection`;
    els.detectionBadge.textContent = 'SUPPORTED';
    els.detectionBadge.className = 'badge badge-success';
    els.warningCard.style.display = 'none';
    // Property address block - shown only when the page exposed an address.
    if (d.address) {
      els.detectionAddress.textContent = d.address;
      els.detectionAddressBlock.hidden = false;
    } else {
      els.detectionAddressBlock.hidden = true;
    }
    // IA's DETECT already carries the photo-date verdict (the EXIF dates sit
    // in the page DOM); EZ has to fetch each photo's picture page, so its
    // check runs as a separate async message with a per-job cache.
    if (d.platform === 'IA') renderPhotoDates(d.photoDates, d.jobId, 'IA');
    else runPhotoDateCheck(d);
  } else {
    els.detectionName.textContent = 'Unsupported page';
    els.detectionBadge.textContent = 'NOT SUPPORTED';
    els.detectionBadge.className = 'badge badge-warning';
    els.detectionAddressBlock.hidden = true;
    els.detectionPhotoDatesBlock.hidden = true;
    els.warningCard.style.display = 'block';
    els.warningBody.textContent =
      'SmartFill verifies inspection answers against the photos, but it only ' +
      'works on an EZ Inspections job page or an Inspector ADE inspection. ' +
      'Open one from ezinspections.com/inspManager/… or inspectorade.com/orders, ' +
      'then click ↻ to detect it - no reload needed.';
  }

  if (working) return; // leave the in-progress canvas/queue untouched

  // ── Status canvas + queue ────────────────────────────────────────
  // Results belong to the page they were produced on (pipelinePageKey).
  // Leaving that page hides them (kept in memory); returning restores them -
  // so a tab switch never loses the review queue.
  // Each job's results are retained by job-id key; restore them whenever the
  // active tab is a job we've already synced (works across two job tabs).
  const key = pageKeyFor(d);
  const rec = supported && key ? state.resultsByJob[key] : null;

  if (!supported) {
    showUnsupportedState();
  } else if (rec && rec.entries.length) {
    activateJob(rec);
    restoreFormOutput();
  } else {
    showReadyState(d);
  }
}

// ── Photo-date check (stale photos) ──────────────────────────────────
// Both platforms compare each photo's taken date (by day) with the job's
// completed date and render the same verdict under the address: green "okay"
// when every dated photo matches, or a red flag pinning each stale photo's
// thumbnail (click opens the on-page viewer).
//
// EZ: the dates live on each photo's JobPictureViewer page, so content-ez.js
// exposes a separate async CHECK_PHOTO_DATES message returning
//   { completedDate, completedDay, total, withDate, noDate, stale:[...] };
// results + fetched thumbnails are cached per job so re-detects don't refetch.
// IA: the EXIF dates already sit in the page DOM, so DETECT returns the same
// shape inline as detection.photoDates (no extra fetch, no result cache).
const photoDateCache = {};   // EZ only: jobId → result (pd)
const photoDatePending = {}; // EZ only: jobId → true while its check is in flight
const staleThumbCache = { jobId: null, thumbs: {} }; // attid → object/data URL

function runPhotoDateCheck(d) {
  const block = els.detectionPhotoDatesBlock;
  const jobId = d && d.jobId;
  // Nothing to check: no job id, or no photos on the page.
  if (!jobId || !d.photoCount) {
    block.hidden = true;
    return;
  }
  block.hidden = false;

  // Already have a result for this job → render it (no refetch).
  if (photoDateCache[jobId]) {
    renderPhotoDates(photoDateCache[jobId], jobId, 'EZ');
    return;
  }

  // Show the "checking" state; kick off the fetch once per job.
  els.photoDatesFlag.className = 'photodates-flag is-checking';
  els.photoDatesFlag.innerHTML =
    `<div class="photodates-msg">${iconSpinner()}<span>Checking photo dates…</span></div>`;
  if (photoDatePending[jobId]) return;
  photoDatePending[jobId] = true;

  sendToTab({ type: 'CHECK_PHOTO_DATES' })
    .then((res) => {
      photoDatePending[jobId] = false;
      if (!res || !res.ok || !res.result) {
        els.photoDatesFlag.className = 'photodates-flag';
        els.photoDatesFlag.innerHTML =
          `<div class="photodates-msg"><span>Couldn’t read photo dates.</span></div>`;
        return;
      }
      // Only cache a conclusive result. A missing completedDate means EZ hadn't
      // finished populating the "Completed Date Time" label when it was read (slow
      // load) - caching that would pin the empty read forever, since a re-detect
      // short-circuits to the cache. Leaving it uncached lets the next detect
      // (tab update / window focus / EZ_PAGE_READY) retry and self-heal.
      if (res.result.completedDate) {
        photoDateCache[jobId] = res.result;
      }
      // Only render if the user is still on this job's tab.
      if (state.detection && state.detection.jobId === jobId) {
        renderPhotoDates(res.result, jobId, 'EZ');
      }
    })
    .catch(() => {
      photoDatePending[jobId] = false;
      els.photoDatesFlag.className = 'photodates-flag';
      els.photoDatesFlag.innerHTML =
        `<div class="photodates-msg"><span>Switch to the job tab to check photo dates.</span></div>`;
    });
}

function renderPhotoDates(pd, jobId, platform) {
  const block = els.detectionPhotoDatesBlock;
  const flag = els.photoDatesFlag;
  // No completed date on the page → nothing to compare against.
  if (!pd || !pd.completedDate || !pd.total) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const stale = pd.stale || [];
  const day = pd.completedDay || pd.completedDate;
  // The page's own name for the completed-date field.
  const dateLabel = platform === 'IA' ? 'Date Completed' : 'Completed Date Time';

  if (!stale.length) {
    const extra = pd.noDate
      ? ` · ${pd.noDate} photo${pd.noDate === 1 ? '' : 's'} without a readable date`
      : '';
    flag.className = 'photodates-flag is-ok';
    flag.innerHTML =
      `<div class="photodates-msg">${iconCheck()}<span>Okay - all ` +
      `${pd.withDate} photo date${pd.withDate === 1 ? '' : 's'} match ${dateLabel} ` +
      `(${escapeHtml(day)})${escapeHtml(extra)}</span></div>`;
    return;
  }

  if (staleThumbCache.jobId !== jobId) {
    staleThumbCache.jobId = jobId;
    staleThumbCache.thumbs = {};
  }

  const items = stale
    .map((p, i) => {
      const src = staleThumbCache.thumbs[p.attid] || '';
      const imgEl = src
        ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(p.label || 'Photo')}" />`
        : `<span class="stale-thumb-ph">…</span>`;
      // EZ stale photos carry takenOn ("6/25/2026 7:46 AM"), IA ones imageDate
      // ("2026-06-30 14:48:11") - either way the day is the first token.
      const taken = p.takenOn || p.imageDate || '';
      const takenDay = taken.split(' ')[0].slice(0, 10);
      const title = `${p.label || 'Photo'} · taken ${taken || 'unknown'}`;
      return `<button class="stale-thumb" data-idx="${i}" title="${escapeHtml(title)}">
          ${imgEl}
          <span class="stale-thumb-date">${escapeHtml(takenDay)}</span>
        </button>`;
    })
    .join('');

  flag.className = 'photodates-flag is-warn';
  flag.innerHTML =
    `<div class="photodates-msg">${iconX()}<span><strong>${stale.length}</strong> photo` +
    `${stale.length === 1 ? '' : 's'} not taken on ${dateLabel} ` +
    `(${escapeHtml(day)}) - check the pinned image${stale.length === 1 ? '' : 's'} below.</span></div>` +
    `<div class="stale-thumbs">${items}</div>`;

  hydrateStaleThumbs(stale, jobId, platform);
}

// Fetch missing stale-photo thumbnails, then re-render the flag. A second pass
// finds nothing missing, so this never loops.
// EZ: fetched from the panel (host permissions + session cookie) into object
// URLs. IA: inspectorade.com photos sit behind a SameSite cookie the panel's
// cross-site fetch can't send, so they're fetched in the PAGE origin via the
// content script (FETCH_IMAGES) as data URLs.
async function hydrateStaleThumbs(stale, jobId, platform) {
  const missing = stale.filter((p) => !staleThumbCache.thumbs[p.attid]);
  if (!missing.length) return;
  let got = false;

  if (platform === 'IA') {
    let res = null;
    try {
      res = await sendToTab({
        type: 'FETCH_IMAGES',
        preferFullRes: false,
        items: missing.map((p) => ({
          id: p.attid,
          thumbnailUrl: p.thumbnailUrl,
          fullResUrl: p.fullResUrl,
        })),
      });
    } catch (e) {
      return; // not on the inspection tab - placeholders stay
    }
    if (!res || !res.ok || staleThumbCache.jobId !== jobId) return;
    for (const img of res.images || []) {
      if (img && img.id && img.dataUrl) {
        staleThumbCache.thumbs[img.id] = img.dataUrl;
        got = true;
      }
    }
  } else {
    for (const p of missing) {
      if (staleThumbCache.jobId !== jobId) return; // job changed mid-fetch
      const res = await fetchImageBlob(p, false); // thumbnail first
      if (res && res.blob) {
        staleThumbCache.thumbs[p.attid] = URL.createObjectURL(res.blob);
        got = true;
      }
    }
  }

  const pd = platform === 'IA'
    ? state.detection && state.detection.photoDates
    : photoDateCache[jobId];
  if (got && state.detection && state.detection.jobId === jobId && pd) {
    renderPhotoDates(pd, jobId, platform);
  }
}

// Pinned stale thumbnail → open the on-page viewer with the stale gallery. The
// viewer runs in the page context (blob: URLs from the panel are invalid there),
// so pass the same-origin network URLs it can load with the session cookie.
// picture (EZ only) lets the viewer resolve the true full-size image when the
// guessed full-res URL 404s; IA items simply have no pictureUrl.
els.photoDatesFlag.addEventListener('click', (e) => {
  const btn = e.target.closest('.stale-thumb');
  if (!btn) return;
  const d = state.detection;
  const jobId = d && d.jobId;
  const pd = d && (d.platform === 'IA' ? d.photoDates : jobId && photoDateCache[jobId]);
  const stale = (pd && pd.stale) || [];
  if (!stale.length) return;
  const gallery = stale
    .map((p) => ({ full: p.fullResUrl || p.thumbnailUrl, thumb: p.thumbnailUrl, picture: p.pictureUrl || '' }))
    .filter((g) => g.full || g.thumb);
  openImageOnPage(gallery, Math.max(0, Number(btn.dataset.idx) || 0));
});

// Supported page, nothing to restore → fresh "ready to sync" canvas.
function showReadyState(d) {
  state.pipeline = 'idle';
  // No saved results for this job - detach the active view. Any stored record
  // stays in resultsByJob and restores when we return to that job's tab.
  state.entries = [];
  state.pipelinePageKey = null;
  setSyncButton('Sync & Verify with AI', false);
  setStatusBadge('READY', 'idle');
  els.canvasTitle.textContent = 'Ready';
  els.canvasSubtitle.innerHTML =
    `Found <strong>${d.questionCount || 0}</strong> question${d.questionCount === 1 ? '' : 's'}` +
    ` and <strong>${d.photoCount || 0}</strong> photo${d.photoCount === 1 ? '' : 's'}.`;
  setRingProgress(0);
  setRingSpinning(false);
  els.queueCard.style.display = 'none';
  setConnection('idle', 'Idle');
}

// Not an EZ page → hide the queue but KEEP state.entries in memory, so
// switching back to the results' page restores them.
function showUnsupportedState() {
  setSyncButton('Sync & Verify with AI', true);
  setStatusBadge('UNSUPPORTED', 'warning');
  els.canvasTitle.textContent = 'Ready';
  els.canvasSubtitle.textContent = STATUS_DESCRIPTIONS.unsupported;
  setRingProgress(0);
  setRingSpinning(false);
  els.queueCard.style.display = 'none';
  setConnection('idle', 'Idle');
}

// Back on the page a completed run belongs to → re-show its queue (the
// Accept/Reject decisions are still held in state.entries).
function restoreFormOutput() {
  state.pipeline = 'complete';
  setSyncButton('Verified', true); // stays greyed for an already-verified job
  setStatusBadge('COMPLETE', 'success');
  els.canvasTitle.textContent = 'Analysis complete';
  els.canvasSubtitle.textContent =
    `Review ${state.entries.length} AI answer${state.entries.length === 1 ? '' : 's'} below.`;
  setRingProgress(100);
  setRingSpinning(false);
  setConnection('online', 'Online');
  renderQueue();
  els.queueCard.style.display = 'block';
}

// ── Multi-job result retention ───────────────────────────────────────
// Each completed sync is stored under its job-id key, so two job tabs open in
// one window each keep - and independently restore - their own review queue.
const MAX_JOBS = 15; // cap retained jobs to bound memory (cached blob URLs)

function revokeJobBlobs(rec) {
  if (!rec || !rec.photoBlobUrls) return;
  for (const u of Object.values(rec.photoBlobUrls)) {
    try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
  }
}

// Persist the just-finished run for the active job, then evict the oldest jobs
// past the cap (freeing their object URLs).
function storeJobResult() {
  const key = state.pipelinePageKey;
  if (!key) return;
  if (!state.resultsByJob[key]) state.jobOrder.push(key);
  state.resultsByJob[key] = {
    jobKey: key,
    jobId: state.detection && state.detection.jobId,
    platform: state.pipelinePlatform || (state.detection && state.detection.platform) || 'EZ',
    resultId: state.resultId,
    feedbackSent: false,
    entries: state.entries,
    scraped: state.scraped,
    photoBlobUrls: state.photoBlobUrls,
  };
  while (state.jobOrder.length > MAX_JOBS) {
    const old = state.jobOrder.shift();
    if (old === key) { state.jobOrder.push(old); break; } // never evict the active one
    const rec = state.resultsByJob[old];
    if (rec) { revokeJobBlobs(rec); delete state.resultsByJob[old]; }
  }
  schedulePersist();
}

// Point the active view at a stored job's data (entries / scraped / thumbs)
// so accept/reject mutate the same objects the record holds.
function activateJob(rec) {
  state.entries = rec.entries;
  state.scraped = rec.scraped;
  state.photoBlobUrls = rec.photoBlobUrls;
  state.pipelinePageKey = rec.jobKey;
  state.resultId = rec.resultId || '';
  state.feedbackSent = !!rec.feedbackSent;
}

// ── Persistence ──────────────────────────────────────────────────────
// Save each job's queue + Accept/Reject decisions to chrome.storage so closing
// and reopening the side panel doesn't lose work. Object URLs (blob:) are NOT
// persisted - they're dead after a reload; reference thumbnails fall back to the
// live EZ thumbnail URL when a cached blob is absent.
function serializeJob(rec) {
  return {
    jobKey: rec.jobKey,
    jobId: rec.jobId,
    platform: rec.platform,
    resultId: rec.resultId,
    feedbackSent: rec.feedbackSent,
    entries: rec.entries,
    scraped: rec.scraped,
  };
}

function persistJobs() {
  if (!hasChromeStorage) return;
  try {
    const jobs = state.jobOrder
      .map((k) => state.resultsByJob[k])
      .filter(Boolean)
      .map(serializeJob);
    const p = chrome.storage.local.set({ [STORAGE_JOBS_KEY]: { jobs, savedAt: Date.now() } });
    if (p && p.catch) p.catch(() => { }); // swallow async quota errors
  } catch (e) { /* storage full / unavailable - non-fatal */ }
}

let persistTimer = null;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistJobs, 300);
}

async function loadJobs() {
  if (!hasChromeStorage) return;
  try {
    const got = await chrome.storage.local.get(STORAGE_JOBS_KEY);
    const saved = got && got[STORAGE_JOBS_KEY];
    if (!saved || !Array.isArray(saved.jobs)) return;
    for (const j of saved.jobs) {
      if (!j || !j.jobKey || !Array.isArray(j.entries)) continue;
      state.resultsByJob[j.jobKey] = {
        jobKey: j.jobKey,
        jobId: j.jobId,
        platform: j.platform || 'EZ',
        resultId: j.resultId || '',
        feedbackSent: !!j.feedbackSent,
        entries: j.entries,
        scraped: j.scraped,
        photoBlobUrls: {}, // blob URLs don't survive a reload; rebuilt lazily
      };
      state.jobOrder.push(j.jobKey);
    }
  } catch (e) { /* ignore - start with no restored jobs */ }
}

// ═════════════════════════════════════════════════════════════════════
// 6. Status canvas helpers
// ═════════════════════════════════════════════════════════════════════

function setRingProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  const circumference = 175.93; // 2π * 28
  els.ringProgress.style.strokeDashoffset = circumference * (1 - clamped / 100);
  els.canvasProgressLabel.textContent = `${Math.round(clamped)}% COMPLETED`;
}

function setRingSpinning(on) {
  els.canvasRing.classList.toggle('is-spinning', !!on);
}

function setStatusBadge(label, kind) {
  els.statusBadge.textContent = label;
  els.statusBadge.className = `badge badge-${kind || 'idle'}`;
}

// Sync button label + enabled state. The button is greyed out after a run
// completes so the operator can't re-fire the same job (repeating the API call);
// the ↻ button clears the result to allow a deliberate re-run.
function setSyncButton(label, disabled) {
  const span = els.btnSync.querySelector('span');
  if (span && label) span.textContent = label;
  els.btnSync.disabled = !!disabled;
}

// ═════════════════════════════════════════════════════════════════════
// 7. Image fetching (evidence for the verify call) - EZ only
// ═════════════════════════════════════════════════════════════════════
//
// IA photos are NOT fetched here: inspectorade.com images sit behind a
// SameSite session cookie the panel's cross-site fetch can't send, so the IA
// pipeline asks the content script to fetch them in the page origin instead
// (FETCH_IMAGES → data URLs). Everything below is the EZ strategy.

// Resolve a photo's real full-size image URL by loading its picture-detail page
// (JobPictureViewer.aspx) and reading img#Main_Picture, which points at
// utility/downloadUtil.aspx?...&key=<per-request key>.
//
// This is the ONLY reliable way to get the full image. The full-size file that
// fullResUrl names is generated by EZ lazily - it does not exist until the
// photo has been opened through this viewer flow, so fetching fullResUrl
// directly 404s for any photo nobody has opened yet, and the fetch below then
// falls back to the thumbnail. That is why a single sync used to upload a mix
// of full-size photos (previously viewed) and 3 KB thumbnails (never viewed).
// Requesting the viewer URL both generates the file and returns its address.
//
// Nothing in this chain needs the EZ session cookie, so the panel can fetch it
// directly (host_permissions exempt extension pages from CORS).
async function resolveSourceUrl(photo) {
  if (!photo || !photo.pictureUrl) return null;
  if (photo.sourceUrl) return photo.sourceUrl;
  try {
    const resp = await fetch(photo.pictureUrl, { credentials: 'include' });
    if (!resp.ok) return null;
    const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
    const pic = doc.getElementById('Main_Picture');
    const src = pic && pic.getAttribute('src');
    if (!src) return null;
    photo.sourceUrl = new URL(src, resp.url || photo.pictureUrl).href;
    return photo.sourceUrl;
  } catch (e) {
    return null;
  }
}

// Try each candidate URL in order; return the first that yields a real image.
// An expired session or an error page is HTML, not an image - skip it rather
// than uploading a login page as if it were a photo.
async function firstImageBlob(urls) {
  for (const url of urls) {
    if (!url) continue;
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) continue;
      const blob = await resp.blob();
      if (blob.size > 0 && /^image\//.test(blob.type)) return { blob, url };
    } catch (e) {
      // try next candidate
    }
  }
  return null;
}

// Fetch one photo into a Blob.
//
// For full-res we try the GUESSED full-size URL (thumbnail path with
// "/thumbnail" stripped) FIRST. Measured against live jobs, that file already
// exists for photos that have been generated - one request returns the true
// full-size image, identical bytes to the viewer flow. Only when the guess
// genuinely fails (404 / non-image, i.e. EZ hasn't generated the file yet) do
// we fall back to the slow viewer flow: resolveSourceUrl() drives
// JobPictureViewer.aspx, which both GENERATES the file and returns its real
// downloadUtil.aspx URL. That fallback is two round-trips; the guess-first path
// is one, so the common case is ~2-3x faster per photo. Thumbnail is the last
// resort either way.
async function fetchImageBlob(photo, useFullRes) {
  if (!useFullRes) {
    return firstImageBlob([photo.thumbnailUrl, photo.fullResUrl]);
  }
  const direct = await firstImageBlob([photo.fullResUrl]);
  if (direct) return direct;
  // Guess missing → drive the viewer to generate + locate the real file.
  const viaViewer = await resolveSourceUrl(photo);
  return firstImageBlob([viaViewer, photo.thumbnailUrl]);
}

// Fetch full image blobs for a photo list, using the platform's strategy.
//   EZ: fetched from the panel with a 5-way concurrency pool (guess-first
//       full-res, viewer fallback - see fetchImageBlob).
//   IA: delegated to the PAGE origin (FETCH_IMAGES → data URLs) so the
//       SameSite session cookie rides along.
// Returns { images: { <attid>: { blob, displayUrl, ext } }, thumbCount }.
// `displayUrl` renders directly in the panel/viewer (object URL for EZ, data
// URL for IA). onProgress(done, total) is optional. Never throws - a photo
// that fails to load is simply absent from `images`.
async function fetchImagesForPhotos({ photos, platform, fullRes, tab, onProgress }) {
  const images = {};
  const total = photos.length;
  let thumbCount = 0;

  if (platform === 'IA') {
    const items = photos.map((p) => ({
      id: p.attid,
      fullResUrl: p.fullResUrl,
      thumbnailUrl: p.thumbnailUrl,
    }));
    let fetched = [];
    if (total) {
      try {
        const imgRes = await messageTab(tab, { type: 'FETCH_IMAGES', items, preferFullRes: fullRes });
        fetched = (imgRes && imgRes.images) || [];
      } catch (e) {
        // leave images empty; the caller surfaces the miss in its summary
      }
    }
    for (const r of fetched) {
      if (!r || !r.dataUrl || !r.id) continue;
      const blob = await (await fetch(r.dataUrl)).blob();
      images[r.id] = { blob, displayUrl: r.dataUrl, ext: 'jpg' };
    }
    if (onProgress) onProgress(total, total);
    return { images, thumbCount };
  }

  // EZ
  let done = 0;
  const fetchOne = async (photo) => {
    const got = await fetchImageBlob(photo, fullRes);
    const id = photo.attid;
    if (got && id) {
      const ext = (photo.filename && photo.filename.split('.').pop()) || 'jpg';
      images[id] = { blob: got.blob, displayUrl: URL.createObjectURL(got.blob), ext };
      if (got.url === photo.thumbnailUrl) thumbCount++;
    }
    done++;
    if (onProgress) onProgress(done, total);
  };
  const PHOTO_CONCURRENCY = 5;
  let cursor = 0;
  const worker = async () => {
    while (cursor < photos.length) await fetchOne(photos[cursor++]);
  };
  await Promise.all(Array.from({ length: Math.min(PHOTO_CONCURRENCY, total) }, worker));
  return { images, thumbCount };
}

// ── Prefetch (in-memory) ─────────────────────────────────────────────
// When a job is detected we fetch its full-res photos in the background and
// stash the blobs by job key, so clicking Sync skips straight past the photo
// phase. Best-effort only: if a prefetch is missing, partial, or failed, the
// pipeline (ensureImages) fetches whatever's missing normally - so prefetch can
// never break or slow a sync, only speed it up. Not persisted (in-memory).
const prefetchCache = {}; // pageKey → { platform, ts, promise, images, thumbCount }
const PREFETCH_TTL_MS = 5 * 60 * 1000; // a stale prefetch is re-run, not reused
const PREFETCH_MAX = 4;                // distinct jobs held at once

function revokePrefetchImages(images) {
  if (!images) return;
  for (const im of Object.values(images)) {
    if (im && typeof im.displayUrl === 'string' && im.displayUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(im.displayUrl); } catch (e) { /* ignore */ }
    }
  }
}

// Free object URLs for the oldest prefetches once we exceed the cap.
function evictOldPrefetch() {
  const keys = Object.keys(prefetchCache).sort((a, b) => prefetchCache[a].ts - prefetchCache[b].ts);
  while (keys.length > PREFETCH_MAX) {
    const k = keys.shift();
    revokePrefetchImages(prefetchCache[k].images);
    delete prefetchCache[k];
  }
}

// Kick off a background full-res fetch for a detected job (once per job/TTL).
function schedulePrefetch(d, tab) {
  const key = pageKeyFor(d);
  if (!key || !tab || !d || !d.supported) return;
  const existing = prefetchCache[key];
  if (existing && Date.now() - existing.ts < PREFETCH_TTL_MS) return; // already in flight / fresh
  if (existing) revokePrefetchImages(existing.images); // stale re-run: free the old blobs first

  const entry = { platform: d.platform || 'EZ', ts: Date.now(), images: {}, thumbCount: 0, promise: null };
  prefetchCache[key] = entry;
  const t0 = Date.now();
  entry.promise = (async () => {
    try {
      const sres = await messageTab(tab, { type: 'SCRAPE' });
      const photos = (sres && sres.ok && sres.data && sres.data.photos) || [];
      if (!photos.length) return;
      const { images, thumbCount } = await fetchImagesForPhotos({
        photos, platform: entry.platform, fullRes: state.config.fullRes, tab,
      });
      entry.images = images;
      entry.thumbCount = thumbCount;
      logActivity(
        `Prefetched ${Object.keys(images).length}/${photos.length} photos (${entry.platform}) - ${Date.now() - t0} ms`,
      );
    } catch (e) {
      // best-effort; Sync will fetch normally
    }
  })();
  evictOldPrefetch();
}

// Resolve every photo's image blob for a sync: consume a matching prefetch if
// present (its blob-URL ownership transfers to the caller), then fetch any
// photos the prefetch didn't cover. Guarantees no photo is silently dropped.
async function ensureImages({ pageKey, photos, platform, fullRes, tab, onProgress }) {
  let images = {};
  let thumbCount = 0;

  const cached = prefetchCache[pageKey];
  if (cached && Date.now() - cached.ts < PREFETCH_TTL_MS) {
    try { await cached.promise; } catch (e) { /* fall through to a fresh fetch */ }
    images = { ...(cached.images || {}) };
    thumbCount = cached.thumbCount || 0;
    delete prefetchCache[pageKey]; // consumed: don't revoke, ownership moves to the caller
  }

  const missing = photos.filter((p) => !images[p.attid]);
  if (missing.length) {
    const covered = photos.length - missing.length;
    const fresh = await fetchImagesForPhotos({
      photos: missing, platform, fullRes, tab,
      onProgress: onProgress ? (d) => onProgress(covered + d, photos.length) : null,
    });
    Object.assign(images, fresh.images);
    thumbCount += fresh.thumbCount;
  } else if (onProgress) {
    onProgress(photos.length, photos.length); // everything came from prefetch
  }

  return { images, thumbCount };
}

// ═════════════════════════════════════════════════════════════════════
// 8. The pipeline: scrape → fetch photos → POST → build queue
// ═════════════════════════════════════════════════════════════════════

els.btnSync.addEventListener('click', startPipeline);
els.btnRefresh.addEventListener('click', () => {
  // Re-detect. If the active job already has results, clear them first so the
  // operator can deliberately re-run - the Sync button greys out after a
  // completed run to prevent accidental repeat API calls.
  const key = pageKeyFor(state.detection);
  if (key && state.resultsByJob[key]) {
    autoSendFeedback(state.resultsByJob[key], false); // flush unsent decisions first
    revokeJobBlobs(state.resultsByJob[key]);
    delete state.resultsByJob[key];
    state.jobOrder = state.jobOrder.filter((k) => k !== key);
    state.entries = [];
    state.pipelinePageKey = null;
    state.resultId = '';
    state.feedbackSent = false;
    schedulePersist(); // drop the reset job from persisted storage too
  }
  detect();
});

// ── Address actions ──────────────────────────────────────────────────
// Copy the detected address to the clipboard.
async function copyAddress() {
  const addr = state.detection && state.detection.address;
  if (!addr) { showToast('No address detected'); return; }
  try {
    await navigator.clipboard.writeText(addr);
    showToast('Address copied');
    logActivity('Address copied to clipboard', 'success');
  } catch (e) {
    showToast('Copy failed: ' + e.message);
  }
}

// Open a URL in a new tab placed immediately to the right of the current tab.
async function openUrlBesideTab(url, logLabel) {
  try {
    if (hasChromeTabs && chrome.tabs && chrome.tabs.create) {
      const tab = await activeTab();
      await chrome.tabs.create({
        url,
        index: tab ? tab.index + 1 : undefined, // open to the right of this tab
        active: true,
      });
    } else {
      window.open(url, '_blank');
    }
    if (logLabel) logActivity(logLabel, 'info');
  } catch (e) {
    showToast('Could not open tab: ' + e.message);
  }
}

// Open a Google search for the address.
function openAddressInGoogle() {
  const addr = state.detection && state.detection.address;
  if (!addr) { showToast('No address detected'); return; }
  openUrlBesideTab('https://www.google.com/search?q=' + encodeURIComponent(addr), 'Opened address in Google');
}

// Open the address in Google Maps.
function openAddressInMaps() {
  const addr = state.detection && state.detection.address;
  if (!addr) { showToast('No address detected'); return; }
  openUrlBesideTab(
    'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr),
    'Opened address in Maps'
  );
}

if (els.btnCopyAddress) els.btnCopyAddress.addEventListener('click', copyAddress);
if (els.btnOpenAddress) els.btnOpenAddress.addEventListener('click', openAddressInGoogle);
if (els.btnMapAddress) els.btnMapAddress.addEventListener('click', openAddressInMaps);

async function startPipeline() {
  if (!state.detection?.supported) {
    showToast('Open an EZ Inspections or Inspector ADE page first');
    return;
  }

  state.pipeline = 'scraping';
  state.entries = [];
  state.resultId = '';
  state.feedbackSent = false;
  els.queueCard.style.display = 'none';
  els.btnSync.disabled = true;
  setStatusBadge('IN PROGRESS', 'progress');
  els.canvasTitle.textContent = 'Reading job';
  els.canvasSubtitle.textContent = 'Extracting questions and current answers.';
  setRingProgress(10);
  setRingSpinning(true);
  setConnection('idle', 'Working…');
  state.apiStartMs = Date.now();
  state.pipelinePageKey = pageKeyFor(state.detection);
  state.pipelinePlatform = state.detection.platform || 'EZ';
  logActivity(`Sync started (${state.pipelinePlatform})`);

  try {
    // 1. Scrape
    const tScrape0 = Date.now();
    const sres = await sendToTab({ type: 'SCRAPE' });
    if (!sres || !sres.ok) throw new Error('Scrape failed - is this an inspection page?');
    state.scraped = sres.data;
    const qCount = state.scraped.sections.reduce((n, s) => n + s.questions.length, 0);
    if (qCount === 0) throw new Error('No questions found on this page.');
    logActivity(`Scraped ${qCount} questions, ${state.scraped.photos.length} photos - ${Date.now() - tScrape0} ms`);

    // 2. Fetch photo blobs
    state.pipeline = 'uploading';
    els.canvasTitle.textContent = 'Fetching photos';
    const form = new FormData();
    const payload = {
      platform: state.pipelinePlatform, // "EZ" | "IA" - which site this job came from
      jobId: state.scraped.jobId,
      work_code: state.scraped.workCode || null,
      sections: state.scraped.sections,
      photos: [],
    };

    // Re-syncing this job? Free the previous run's cached object URLs for it.
    revokeJobBlobs(state.resultsByJob[state.pipelinePageKey]);
    state.photoBlobUrls = {};

    // The backend only needs each photo's id + category; the extension keeps the
    // full scraped photo (with its URLs) and rebuilds image URLs from the id.
    for (const photo of state.scraped.photos) {
      payload.photos.push({ id: photo.attid, category: photo.category });
    }

    const photosList = state.scraped.photos;
    const total = photosList.length;

    // Resolve every photo's blob: reuse the detection-time prefetch when present,
    // otherwise fetch now (EZ from the panel, IA via the page origin). Photo
    // fetching is the pipeline's slowest stage, so it's timed here.
    if (total) els.canvasSubtitle.textContent = `Fetching photos… 0/${total}`;
    const tImg0 = Date.now();
    const tab = await activeTab();
    const { images, thumbCount } = await ensureImages({
      pageKey: state.pipelinePageKey,
      photos: photosList,
      platform: state.pipelinePlatform,
      fullRes: state.config.fullRes,
      tab,
      onProgress: (fdone, ftotal) => {
        els.canvasSubtitle.textContent = `Fetching photos… ${fdone}/${ftotal}`;
        setRingProgress(10 + Math.round((fdone / Math.max(1, ftotal)) * 40));
      },
    });

    // Build the multipart body from the resolved blobs, in scraped order. Each
    // file is named "<id>.<ext>" so the backend maps bytes → photo by id, and
    // FormData.append is synchronous so order doesn't matter to the backend.
    for (const photo of photosList) {
      const im = images[photo.attid];
      if (!im) continue; // failed to load → skipped (its card has no thumbnail)
      form.append('images', im.blob, `${photo.attid}.${im.ext || 'jpg'}`);
      // Cache the display URL so reference-photo thumbnails + the viewer render
      // without a second fetch (object URL for EZ, data URL for IA).
      state.photoBlobUrls[photo.attid] = im.displayUrl;
    }
    setRingProgress(50);

    // For the end-of-sync summary: how many photos actually loaded.
    const okCount = Object.keys(state.photoBlobUrls).length;
    state.lastPhotoStats = { total, ok: okCount };
    logActivity(`Photos ready: ${okCount}/${total} - ${Date.now() - tImg0} ms`);
    // Surface a silent downgrade: if the full image can't be resolved the fetch
    // falls back to the thumbnail, and the AI would be judging a 3 KB image.
    if (state.config.fullRes && thumbCount) {
      logActivity(
        `${thumbCount}/${total} photos sent as thumbnails - full-size image not available`,
        'error'
      );
    } else if (state.config.fullRes && okCount) {
      logActivity(`Sent ${okCount} full-size photos`, 'success');
    }

    form.append('payload', JSON.stringify(payload));

    // 3. POST to the verify backend
    state.pipeline = 'analyzing';
    els.canvasTitle.textContent = 'Analyzing';
    els.canvasSubtitle.textContent = 'Sending to the AI backend…';
    setRingProgress(70);
    const tPost0 = Date.now();
    const resp = await fetch(VERIFY_URL, { method: 'POST', body: form });
    logActivity(`Backend responded - ${Date.now() - tPost0} ms`);
    if (!resp.ok) throw new Error(`Backend error ${resp.status}`);
    const data = await resp.json();
    state.resultId = data.result_id || '';

    const aiById = {};
    for (const a of data.answers || []) aiById[a.questionId] = a;

    // 4. Build, store (per job) + render the queue
    state.entries = buildEntries(state.scraped.sections, aiById);
    storeJobResult();
    handlePipelineSuccess();
  } catch (e) {
    handlePipelineError(e.message || String(e));
  }
}

function handlePipelineSuccess() {
  state.pipeline = 'complete';
  const latency = Date.now() - state.apiStartMs;

  // End-of-sync summary: how many need review vs already matched, and whether
  // any photos failed to load - so the operator knows where to focus.
  const matched = state.entries.filter((e) => e.matchesCurrent).length;
  const toReview = state.entries.length - matched;
  const stats = state.lastPhotoStats || { total: 0, ok: 0 };
  const failed = Math.max(0, stats.total - stats.ok);

  const summaryParts = [`${toReview} to review`, `${matched} matched`];
  if (failed) summaryParts.push(`${failed} photo${failed === 1 ? '' : 's'} not loaded`);
  const summary = summaryParts.join(' · ');

  setStatusBadge('COMPLETE', 'success');
  els.canvasTitle.textContent = 'Analysis complete';
  els.canvasSubtitle.textContent = state.entries.length ? summary : 'No AI answers returned for this job.';
  setRingProgress(100);
  setRingSpinning(false);
  setConnection('online', 'Online');
  setSyncButton('Verified', true); // grey out so the operator can't re-fire the run

  renderQueue();
  els.queueCard.style.display = state.entries.length ? 'block' : 'none';
  if (!state.entries.length) {
    showToast('No AI answers returned for this job');
  } else if (failed) {
    showToast(`${failed} photo${failed === 1 ? '' : 's'} could not be loaded`);
  }
  logActivity(
    `Sync complete: ${state.entries.length} suggestions (${matched} matched, ${toReview} to review` +
    `${failed ? `, ${failed} photos failed` : ''}) - ${latency} ms`,
    'success'
  );
}

function handlePipelineError(message) {
  state.pipeline = 'error';
  setStatusBadge('ERROR', 'error');
  els.canvasTitle.textContent = 'Sync failed';
  els.canvasSubtitle.textContent = message;
  setRingProgress(0);
  setRingSpinning(false);
  setConnection('error', 'Backend error');
  setSyncButton('Sync & Verify with AI', false); // re-enable so a failed run can be retried
  logActivity(`Error: ${message}`, 'error');
  showToast(message);
}

// ═════════════════════════════════════════════════════════════════════
// 9. Entry model
// ═════════════════════════════════════════════════════════════════════
//
// One AI answer per question (EZ contract). An entry is "matched" when the AI
// answer equals the current on-page answer, otherwise it's a real suggestion
// ("different"). Status flows: matched | pending → accepted | rejected, and
// Reconsider returns an accepted/rejected card to pending (reverting the page
// for an accepted one).

function buildEntries(sections, aiById) {
  const entries = [];
  sections.forEach((section) => {
    section.questions.forEach((q) => {
      const ai = aiById[q.id];
      if (!ai) return;
      const aiAnswer = ai.aiAnswer;
      if (aiAnswer == null || String(aiAnswer).trim() === '') return;

      const matchesCurrent = sameAnswer(aiAnswer, q.currentAnswer);
      entries.push({
        uid: q.id,
        sectionText: section.header,
        question: q,                       // { id, text, type, options, currentAnswer }
        aiAnswer,
        confidence: ai.confidence,
        reasoning: ai.reasoning,
        originalAnswer: q.currentAnswer,   // captured for Reconsider
        referenceImages: Array.isArray(ai.referenceImages) ? ai.referenceImages : [],
        matchesCurrent,
        status: matchesCurrent ? 'matched' : 'pending',
      });
    });
  });
  return entries;
}

function formatAnswer(value) {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  return String(value);
}

// ═════════════════════════════════════════════════════════════════════
// 10. Filters + counts
// ═════════════════════════════════════════════════════════════════════

function applyFilter(entries) {
  if (state.filter === 'different') return entries.filter((e) => !e.matchesCurrent);
  if (state.filter === 'matched') return entries.filter((e) => e.matchesCurrent);
  return entries;
}

function updateFilterCounts() {
  els.filterCountAll.textContent = state.entries.length;
  els.filterCountDifferent.textContent = state.entries.filter((e) => !e.matchesCurrent).length;
  els.filterCountMatched.textContent = state.entries.filter((e) => e.matchesCurrent).length;
}

function updateCounts() {
  els.countPending.textContent = state.entries.filter((e) => e.status === 'pending').length;
  els.countAccepted.textContent = state.entries.filter((e) => e.status === 'accepted').length;
  els.countRejected.textContent = state.entries.filter((e) => e.status === 'rejected').length;
}

function updateBulkBar() {
  const anyPending = state.entries.some((e) => e.status === 'pending');
  els.btnAcceptAll.disabled = !anyPending;
  els.btnRejectAll.disabled = !anyPending;
}

document.querySelectorAll('.filter-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.filter = tab.dataset.filter;
    document.querySelectorAll('.filter-tab').forEach((t) => {
      const active = t === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderQueue();
  });
});

// ═════════════════════════════════════════════════════════════════════
// 11. Queue rendering
// ═════════════════════════════════════════════════════════════════════

function renderQueue() {
  const visible = applyFilter(state.entries);
  const emptyCopy = {
    all: { title: 'No suggestions yet', body: 'Run Sync to fetch AI-verified answers.' },
    different: { title: 'Nothing to review', body: 'Every answer already matches the AI - no conflicts.' },
    matched: { title: 'No matches', body: 'No answers match yet - every suggestion needs review.' },
  }[state.filter];

  els.suggestionList.innerHTML = '';
  if (visible.length === 0) {
    els.suggestionList.innerHTML = `
      <div class="empty-state" style="padding:24px;">
        <div class="empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <p>${emptyCopy.title}</p>
        <span>${emptyCopy.body}</span>
      </div>`;
  } else {
    // Render in natural page order; a card keeps its place when accepted/rejected
    // (no re-sorting to the bottom).
    visible.forEach((entry) => els.suggestionList.appendChild(renderSuggestion(entry)));
  }
  updateFilterCounts();
  updateCounts();
  updateBulkBar();
  updateFeedbackButton();
  schedulePersist(); // save any Accept/Reject/Reconsider change (debounced)
}

function renderSuggestion(entry) {
  const node = document.createElement('div');
  node.className = `suggestion is-${entry.status}`;
  node.dataset.uid = entry.uid;
  node.innerHTML = [
    renderHead(entry),
    renderBanner(entry),
    renderBody(entry),
    renderReferences(entry),
    renderActions(entry),
  ].filter(Boolean).join('');

  // Clicking the card (not a button) scrolls to the question and highlights it.
  node.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    focusQuestionInPage(entry.uid);
  });
  return node;
}

function renderHead(entry) {
  const map = {
    pending: { label: 'Needs review', cls: 'is-pending' },
    accepted: { label: 'Applied', cls: 'is-accepted' },
    rejected: { label: 'Rejected', cls: 'is-rejected' },
    matched: { label: 'Matches', cls: 'is-matched' },
  };
  const m = map[entry.status] || map.pending;
  return `
    <div class="suggestion-head">
      <div style="min-width:0;flex:1;">
        <div class="suggestion-section">${escapeHtml(entry.sectionText || 'General')}</div>
        <div class="suggestion-question">${escapeHtml(entry.question.text || '(no label)')}</div>
      </div>
      <span class="suggestion-status ${m.cls}">${m.label}</span>
    </div>`;
}

function renderBanner(entry) {
  if (entry.status === 'accepted') {
    return `<div class="applied-banner banner-success">
      ${iconCheck()} Applied - the AI answer was written into the page.
    </div>`;
  }
  if (entry.status === 'rejected') {
    return `<div class="applied-banner banner-muted">
      ${iconX()} Rejected - the current page answer was kept.
    </div>`;
  }
  return '';
}

function renderBody(entry) {
  // Matched → compact single-line row.
  if (entry.status === 'matched') {
    return `
      <div class="matched-row">
        <span class="matched-icon">${iconCheck()}</span>
        <div class="matched-text">
          <div class="matched-title">Already correct</div>
          <div class="matched-value">${escapeHtml(formatAnswer(entry.aiAnswer))}</div>
        </div>
      </div>`;
  }

  const helper = renderHelper(entry);

  // Accepted → just the AI block (now the live value).
  if (entry.status === 'accepted') {
    return `
      <div class="suggestion-blocks blocks-1">
        ${answerBlock('image', 'AI Suggestion', entry.aiAnswer, helper)}
      </div>`;
  }
  // Rejected → just the current block.
  if (entry.status === 'rejected') {
    return `
      <div class="suggestion-blocks blocks-1">
        ${answerBlock('current', 'Current', entry.originalAnswer, '')}
      </div>`;
  }
  // Pending → Current vs AI side by side.
  return `
    <div class="suggestion-blocks blocks-2">
      ${answerBlock('current', 'Current', entry.question.currentAnswer, '')}
      ${answerBlock('image', 'AI Suggestion', entry.aiAnswer, helper)}
    </div>`;
}

function renderHelper(entry) {
  const bits = [];
  if (entry.confidence != null && !Number.isNaN(Number(entry.confidence))) {
    bits.push(`Confidence ${Math.round(Number(entry.confidence) * 100)}%`);
  }
  if (entry.reasoning) bits.push(escapeHtml(truncate(String(entry.reasoning), 180)));
  return bits.join(' · ');
}

function answerBlock(kind, title, value, helper) {
  return `
    <div class="answer-block answer-block--${kind}">
      <div class="answer-block-head">
        <span class="answer-block-title">${escapeHtml(title)}</span>
      </div>
      <div class="answer-block-value">${escapeHtml(formatAnswer(value))}</div>
      ${helper ? `<div class="answer-block-helper">${helper}</div>` : ''}
    </div>`;
}

function scrapedPhotoByAttid(attid) {
  if (!state.scraped || !attid) return null;
  return state.scraped.photos.find((p) => String(p.attid) === String(attid)) || null;
}

/**
 * Reference photos the AI cited as evidence for this answer. Each ref is
 * { attid, label, category, url }. Thumbnails prefer the blob URL cached during
 * sync (renders reliably in the side panel); clicking opens the full image in a
 * new tab. Hidden for rejected cards.
 */
function renderReferences(entry) {
  if (entry.status === 'rejected') return '';
  const refs = entry.referenceImages || [];
  if (!refs.length) return '';

  const items = refs.map((ref) => {
    // Backend sends { id, category }; the extension resolves the image from its
    // own scraped photos by id (legacy { attid, url } shapes still work).
    const attid = ref.id || ref.attid;
    const photo = attid ? scrapedPhotoByAttid(attid) : null;
    const thumb =
      (attid && state.photoBlobUrls[attid]) ||
      (photo && photo.thumbnailUrl) ||
      ref.url ||
      '';
    const full =
      (photo && (photo.sourceUrl || photo.fullResUrl)) ||
      ref.url ||
      thumb;
    // The on-page viewer runs in the page context, where the panel's blob: URLs
    // are invalid - so give it the real network thumbnail URL to fall back to
    // when the guessed full-res URL 404s, plus the picture-detail page URL so
    // it can resolve the true full-size image (see resolveSourceUrl).
    const thumbNet = (photo && photo.thumbnailUrl) || ref.url || '';
    const picture = (photo && photo.pictureUrl) || '';
    const label = ref.category || (photo && photo.label) || ref.label || 'Photo';
    const title = label;

    if (thumb) {
      return `<button class="ref-thumb" data-full="${escapeHtml(full)}" data-thumb="${escapeHtml(thumbNet)}" data-picture="${escapeHtml(picture)}" title="${escapeHtml(title)}">
        <img src="${escapeHtml(thumb)}" alt="${escapeHtml(label)}" loading="lazy" />
      </button>`;
    }
    // No displayable image - fall back to a text pill that still opens the URL.
    return `<button class="source-photo-link" data-full="${escapeHtml(full)}" data-thumb="${escapeHtml(thumbNet)}" data-picture="${escapeHtml(picture)}">${escapeHtml(label)}</button>`;
  }).join('');

  return `
    <div class="source-photos">
      <div class="source-photos-label">Reference photos</div>
      <div class="source-photos-list ref-thumbs">${items}</div>
    </div>`;
}

function renderActions(entry) {
  if (entry.status === 'matched') return '';
  if (entry.status === 'pending') {
    return `
      <div class="suggestion-actions">
        <button class="action-btn action-reject" data-act="reject" data-uid="${escapeHtml(entry.uid)}">Reject</button>
        <button class="action-btn action-accept" data-act="accept" data-uid="${escapeHtml(entry.uid)}">Accept</button>
      </div>`;
  }
  // accepted | rejected → offer Reconsider
  return `
    <div class="suggestion-actions">
      <button class="action-btn action-reconsider" data-act="reconsider" data-uid="${escapeHtml(entry.uid)}">Reconsider</button>
    </div>`;
}

function iconCheck() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
}
function iconX() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
}
// Spinning ring, used while the photo-date check fetches each picture page.
function iconSpinner() {
  return `<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
}

// ═════════════════════════════════════════════════════════════════════
// 12. Card actions (delegated)
// ═════════════════════════════════════════════════════════════════════

els.suggestionList.addEventListener('click', (e) => {
  // Reference-photo thumbnail / link → open the in-page image viewer. The
  // gallery is this card's reference photos, starting at the clicked one.
  const ref = e.target.closest('.ref-thumb, .source-photo-link');
  if (ref) {
    e.stopPropagation();
    const listEl = ref.closest('.source-photos-list');
    const items = listEl
      ? Array.from(listEl.querySelectorAll('.ref-thumb, .source-photo-link'))
      : [ref];
    const gallery = items
      .map((b) => ({ full: b.dataset.full, thumb: b.dataset.thumb, picture: b.dataset.picture || '' }))
      .filter((g) => g.full || g.thumb);
    openImageOnPage(gallery, Math.max(0, items.indexOf(ref)));
    return;
  }

  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  e.stopPropagation();
  const uid = btn.dataset.uid;
  const act = btn.dataset.act;
  if (act === 'accept') acceptEntry(uid);
  else if (act === 'reject') rejectEntry(uid);
  else if (act === 'reconsider') reconsiderEntry(uid);
});

// Open an image gallery in the on-page viewer (imageModal.js). It renders on
// the inspection page, where the photos are same-origin and load with the
// session cookies. messageTab injects the content scripts on demand if needed;
// if the active tab isn't the inspection page we surface a hint instead.
function openImageOnPage(images, index = 0) {
  const gallery = (Array.isArray(images) ? images : [images]).filter(Boolean);
  if (!gallery.length) return;
  sendToTab({ type: 'SHOW_IMAGE_MODAL', images: gallery, index })
    .then((res) => {
      if (!res || !res.ok) showToast('Switch to the inspection tab to view the image.');
    })
    .catch(() => showToast('Switch to the inspection tab to view the image.'));
}

function findEntry(uid) {
  return state.entries.find((e) => e.uid === uid);
}

async function applyToPage(fieldKey, value) {
  const res = await sendToTab({ type: 'APPLY_ANSWER', fieldKey, value });
  if (!res || !res.ok) throw new Error((res && res.error) || 'apply failed');
}

async function acceptEntry(uid) {
  const entry = findEntry(uid);
  if (!entry) return;
  try {
    await applyToPage(entry.uid, entry.aiAnswer);
    entry.question.currentAnswer = entry.aiAnswer;
    entry.status = 'accepted';
    renderQueue();
    logActivity(`Accepted: ${truncate(entry.question.text, 50)} → "${truncate(String(entry.aiAnswer), 30)}"`, 'success');
  } catch (err) {
    showToast('Could not apply: ' + err.message);
    logActivity(`Apply failed: ${err.message}`, 'error');
  }
}

function rejectEntry(uid) {
  const entry = findEntry(uid);
  if (!entry) return;
  entry.status = 'rejected';
  renderQueue();
  logActivity(`Rejected: ${truncate(entry.question.text, 50)}`);
}

async function reconsiderEntry(uid) {
  const entry = findEntry(uid);
  if (!entry) return;
  // If we'd applied the AI answer, revert the page back to the original value.
  if (entry.question.currentAnswer !== entry.originalAnswer && entry.originalAnswer != null) {
    try {
      await applyToPage(entry.uid, entry.originalAnswer);
      entry.question.currentAnswer = entry.originalAnswer;
    } catch (err) {
      showToast('Could not revert: ' + err.message);
    }
  }
  entry.status = entry.matchesCurrent ? 'matched' : 'pending';
  renderQueue();
}

els.btnAcceptAll.addEventListener('click', async () => {
  const pending = state.entries.filter((e) => e.status === 'pending');
  for (const entry of pending) {
    try {
      await applyToPage(entry.uid, entry.aiAnswer);
      entry.question.currentAnswer = entry.aiAnswer;
      entry.status = 'accepted';
    } catch (err) {
      logActivity(`Apply failed (${truncate(entry.question.text, 40)}): ${err.message}`, 'error');
    }
  }
  renderQueue();
  logActivity(`Accepted all (${pending.length})`, 'success');
});

els.btnRejectAll.addEventListener('click', () => {
  const pending = state.entries.filter((e) => e.status === 'pending');
  pending.forEach((e) => (e.status = 'rejected'));
  renderQueue();
  logActivity(`Rejected all (${pending.length})`);
});

// ── Feedback ─────────────────────────────────────────────────────────
// POST the operator's Accept/Reject decisions back to the backend, tied to the
// verify run's result_id, so the model can learn from corrections.

function setFeedbackButton(label, disabled) {
  if (!els.btnSendFeedback) return;
  const span = els.btnSendFeedback.querySelector('span');
  if (span && label) span.textContent = label;
  els.btnSendFeedback.disabled = !!disabled;
}

// The button can be used ONCE per job. After feedback is sent (manually or
// auto), it stays greyed out for that job.
function updateFeedbackButton() {
  if (!els.btnSendFeedback) return;
  if (state.feedbackSent) { setFeedbackButton('Feedback sent', true); return; }
  const anyDecided = state.entries.some(
    (e) => e.status === 'accepted' || e.status === 'rejected'
  );
  setFeedbackButton('Send Feedback', !anyDecided);
}

function activeRecord() {
  return state.pipelinePageKey ? state.resultsByJob[state.pipelinePageKey] : null;
}

// Build the feedback body for one job record, or null if it has no Accept/Reject
// decisions to report.
function buildFeedbackBody(rec) {
  if (!rec) return null;
  const entries = rec.entries || [];
  if (!entries.some((e) => e.status === 'accepted' || e.status === 'rejected')) return null;
  const feedback = entries
    .filter((e) => e.status === 'accepted' || e.status === 'rejected' || e.status === 'matched')
    .map((e) => ({
      questionId: e.uid,
      section: e.sectionText,
      question: e.question.text,
      currentAnswer: e.originalAnswer,
      aiAnswer: e.aiAnswer,
      decision: e.status === 'accepted' ? 'accept' : e.status === 'rejected' ? 'reject' : 'matched',
      finalAnswer: e.question.currentAnswer,
    }));
  return {
    platform: rec.platform || 'EZ', // same tag the verify payload carries
    result_id: rec.resultId || '',
    jobId: rec.jobId || null,
    feedback,
  };
}

// Manual send (button). Sends once, then greys out for this job.
async function sendFeedback() {
  if (state.feedbackSent) { showToast('Feedback already sent for this job'); return; }
  const rec = activeRecord();
  const body = buildFeedbackBody(rec);
  if (!body) { showToast('Make at least one Accept/Reject first'); return; }

  setFeedbackButton('Sending…', true);
  setConnection('idle', 'Sending feedback…');
  try {
    const resp = await fetch(FEEDBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    if (rec) rec.feedbackSent = true;
    state.feedbackSent = true;
    schedulePersist(); // remember that feedback was sent for this job
    setFeedbackButton('Feedback sent', true);
    setConnection('online', 'Online');
    showToast(`Feedback sent (${body.feedback.length})`);
    logActivity(`Feedback sent: ${body.feedback.length} decisions`, 'success');
  } catch (e) {
    setConnection('error', 'Feedback error');
    showToast('Feedback failed: ' + e.message);
    logActivity('Feedback failed: ' + e.message, 'error');
    updateFeedbackButton(); // not sent - leave the button usable
  }
}

// Best-effort auto-send for a job record - on ↻ (viaBeacon=false, a keepalive
// fetch) and on side-panel close (viaBeacon=true, navigator.sendBeacon, which
// survives page unload). Marks the record sent so it never double-fires.
function autoSendFeedback(rec, viaBeacon) {
  if (!rec || rec.feedbackSent) return;
  const body = buildFeedbackBody(rec);
  if (!body) return;
  const url = FEEDBACK_URL;
  rec.feedbackSent = true; // optimistic; prevents a duplicate send
  if (rec === activeRecord()) state.feedbackSent = true;
  schedulePersist();

  if (viaBeacon && navigator.sendBeacon) {
    try {
      navigator.sendBeacon(url, new Blob([JSON.stringify(body)], { type: 'application/json' }));
    } catch (e) { /* unload context - nothing else we can do */ }
    return;
  }
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  })
    .then(() => logActivity(`Feedback auto-sent: ${body.feedback.length} decisions`, 'success'))
    .catch((e) => logActivity('Auto-feedback failed: ' + e.message, 'error'));
}

if (els.btnSendFeedback) els.btnSendFeedback.addEventListener('click', sendFeedback);

// Auto-send every job's unsent decisions when the side panel is closing.
window.addEventListener('pagehide', () => {
  Object.values(state.resultsByJob).forEach((rec) => autoSendFeedback(rec, true));
});

async function focusQuestionInPage(uid) {
  try {
    await sendToTab({ type: 'FOCUS_QUESTION', fieldKey: uid });
  } catch (e) {
    showToast('Switch to the inspection tab to locate this question');
  }
}

// ═════════════════════════════════════════════════════════════════════
// 13. Activity log
// ═════════════════════════════════════════════════════════════════════

function renderActivity() {
  if (!state.activity.length) {
    els.activityList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="3" width="16" height="18" rx="2"/>
            <line x1="8" y1="8" x2="16" y2="8"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
            <line x1="8" y1="16" x2="13" y2="16"/>
          </svg>
        </div>
        <p>No activity yet</p>
        <span>Events will appear here as you sync forms.</span>
      </div>`;
    return;
  }
  els.activityList.innerHTML = state.activity
    .map((a) => {
      const t = a.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const lvl = a.level === 'error' ? ' is-error' : a.level === 'success' ? ' is-success' : '';
      return `<div class="activity-item${lvl}">
        <span class="activity-time">${t}</span>
        <span class="activity-message">${escapeHtml(a.message)}</span>
      </div>`;
    })
    .join('');
}

els.btnClearLog.addEventListener('click', () => {
  state.activity = [];
  renderActivity();
});

// ═════════════════════════════════════════════════════════════════════
// 14. Config (backend URL, full-res, answer-block colours) + persistence
// ═════════════════════════════════════════════════════════════════════

// Light is the default; dark is opt-in. Setting data-theme="dark" on <html>
// activates the :root[data-theme="dark"] rules in the stylesheet. The
// localStorage mirror lets the inline <head> script apply the theme before
// first paint (no flash) on the next open.
function applyTheme() {
  const dark = state.config.theme === 'dark';
  const root = document.documentElement;
  if (dark) root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  try { localStorage.setItem('sf-theme', dark ? 'dark' : 'light'); } catch (e) { /* non-fatal */ }
  if (els.cfgDark) els.cfgDark.checked = dark;
}

function applyColors() {
  const root = document.documentElement;
  for (const key of Object.keys(COLOR_VARS)) {
    const val = state.config.colors[key] || COLOR_DEFAULTS[key];
    root.style.setProperty(COLOR_VARS[key], val);
  }
  if (els.swatchCurrent) els.swatchCurrent.style.background = state.config.colors.current;
  if (els.swatchImage) els.swatchImage.style.background = state.config.colors.image;
  if (els.cfgColorCurrent) els.cfgColorCurrent.value = state.config.colors.current;
  if (els.cfgColorImage) els.cfgColorImage.value = state.config.colors.image;
}

function saveConfig() {
  try {
    chrome.storage.local.set({ [STORAGE_KEY]: state.config });
  } catch (e) { /* storage may be unavailable; non-fatal */ }
}

// Mask a URL for display: hide the host/base, show only the endpoint segment
// (…/verify → *****/verify). The endpoints are fixed, so this is info-only.
function maskUrl(url) {
  const seg = String(url || '').replace(/\/+$/, '').split('/').pop() || '';
  return '*****/' + seg;
}

async function loadConfig() {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const saved = got && got[STORAGE_KEY];
    if (saved) {
      state.config = {
        fullRes: saved.fullRes !== false,
        theme: saved.theme === 'dark' ? 'dark' : 'light',
        colors: { ...COLOR_DEFAULTS, ...(saved.colors || {}) },
      };
    }
  } catch (e) { /* use defaults */ }

  // Endpoints are fixed constants - the Config tab only displays them (masked).
  if (els.cfgVerifyUrl) els.cfgVerifyUrl.value = maskUrl(VERIFY_URL);
  if (els.cfgFeedbackUrl) els.cfgFeedbackUrl.value = maskUrl(FEEDBACK_URL);
  els.cfgFullRes.checked = state.config.fullRes;
  applyTheme();
  applyColors();
}

els.cfgFullRes.addEventListener('change', () => {
  state.config.fullRes = els.cfgFullRes.checked;
  saveConfig();
});
if (els.cfgDark) {
  els.cfgDark.addEventListener('change', () => {
    state.config.theme = els.cfgDark.checked ? 'dark' : 'light';
    applyTheme();
    saveConfig();
  });
}
els.cfgColorCurrent.addEventListener('input', () => {
  state.config.colors.current = els.cfgColorCurrent.value;
  applyColors();
  saveConfig();
});
els.cfgColorImage.addEventListener('input', () => {
  state.config.colors.image = els.cfgColorImage.value;
  applyColors();
  saveConfig();
});
document.querySelectorAll('.color-reset').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    state.config.colors[target] = COLOR_DEFAULTS[target];
    applyColors();
    saveConfig();
  });
});

// ═════════════════════════════════════════════════════════════════════
// 15. Tab-change awareness + init
// ═════════════════════════════════════════════════════════════════════

const hasChromeTabs =
  typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.sendMessage;
const hasChromeStorage =
  typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

// Coalesce rapid auto-detect triggers (tab switch + page-ready can both fire)
// into a single detect() so the detection card doesn't flicker.
let detectTimer = null;
function scheduleDetect() {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(() => detect(), 150);
}

if (hasChromeTabs) {
  chrome.tabs.onActivated.addListener(() => scheduleDetect());
  // Re-detect when a browser window regains focus. Opening a photo in EZ's own
  // viewer (a separate tab/window) makes the panel's active-tab query point at
  // that page, so detection flips to "unsupported"; closing it and returning to
  // the job window fires NO tab-activation event, leaving detection stuck until
  // a manual reload. Re-detecting on window focus recovers automatically.
  if (chrome.windows && chrome.windows.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener((winId) => {
      if (winId === chrome.windows.WINDOW_ID_NONE) return; // focus left Chrome
      scheduleDetect();
    });
  }
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    // Re-detect both while the page is loading and once it completes, so a job
    // opened in the active tab is picked up without waiting on a single event.
    if (tab.active && (info.status === 'complete' || info.status === 'loading')) {
      scheduleDetect();
    }
  });
  // Each content script announces the moment its inspection form is present
  // (EZ_PAGE_READY on EZ job pages, ADE_PAGE_READY on Inspector ADE) - this is
  // what makes detection automatic for a page opened or navigated to after the
  // panel is already open (no manual ↻ / reload needed).
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      const ready = msg && (msg.type === 'EZ_PAGE_READY' || msg.type === 'ADE_PAGE_READY');
      if (ready && (!sender.tab || sender.tab.active)) {
        scheduleDetect();
      }
    });
  }
}

(async function init() {
  await loadConfig();
  await loadJobs(); // restore persisted queues + decisions before first detect
  renderActivity();
  setConnection('idle', 'Idle');
  if (hasChromeTabs) {
    await detect();
  } else {
    // Non-extension context (e.g. a static HTML preview): render the styled
    // shell with sample detection so the layout is visible without Chrome APIs.
    state.detection = {
      supported: true,
      platform: 'EZ',
      jobId: '330890154',
      url: 'https://www.ezinspections.com/inspManager/...',
      address: '22531 JOHN ROLFE LN, Katy, TX, 77449',
      questionCount: 12,
      photoCount: 8,
    };
    renderDetection();
  }
})();
