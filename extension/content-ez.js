// content.js - runs on the ezinspections job edit page.
// Responsibilities:
//   1. Scrape visible sections -> questions -> current answers.
//   2. Scrape photos -> attid, label number, category, thumbnail + guessed full-res URL.
//   3. Apply an answer back into the page (radio / textarea) on request.
//   4. Lightweight DETECT (for the side-panel detection card) + FOCUS_QUESTION
//      (scroll a question into view and flash it, mirroring SmartFill's UX).
//
// Communicates with the side panel via chrome.runtime messages.

(() => {
  // Guard against double-injection. content.js can be loaded two ways - by the
  // manifest `content_scripts` match (on normal page loads) AND on demand via
  // chrome.scripting.executeScript (for pages that were already open before the
  // extension loaded). Running twice would register two message listeners and
  // double every response, so bail out if we've already initialised.
  if (window.__ezVerifierContentLoaded) return;
  window.__ezVerifierContentLoaded = true;

  const GREEN = "rgb(204, 255, 204)"; // highlight color for selected/answered controls


  // Inject the flash stylesheet once. The highlight is a yellow overlay that
  // holds for ~1.5s then fades out, not a persistent box. We use an OVERLAY
  // (drawn on top of the element) rather than a CSS background: a background
  // tint on the FieldGroup table is hidden behind the cells' own opaque
  // backgrounds, but a translucent overlay always shows.
  function ensureHighlightStyle() {
    if (document.getElementById("ez-verifier-style")) return;
    const style = document.createElement("style");
    style.id = "ez-verifier-style";
    style.textContent = `
      .ez-verifier-flash {
        position: absolute;
        z-index: 2147483646;
        pointer-events: none;
        border-radius: 4px;
        background: rgba(250, 204, 21, 0.55);
        box-shadow: 0 0 0 3px rgba(250, 204, 21, 0.45);
        animation: ez-verifier-flash-fade 1.5s ease-out forwards;
      }
      @keyframes ez-verifier-flash-fade {
        0%   { opacity: 0; }
        6%   { opacity: 1; }
        75%  { opacity: 1; }
        100% { opacity: 0; }
      }`;
    (document.head || document.documentElement).appendChild(style);
  }

  // Scroll the question into view, wait for the smooth scroll to settle, then
  // flash. scrollend fires when the smooth scroll finishes; if the element is
  // already in view (no scroll needed) we flash right away, and a timeout
  // covers browsers/paths where scrollend never fires.
  function scrollThenFlash(target) {
    const r = target.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const needsScroll = r.top < 0 || r.bottom > vh;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (!needsScroll) {
      flashHighlight(target);
      return;
    }
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      window.removeEventListener("scrollend", fire);
      clearTimeout(fallback);
      flashHighlight(target);
    };
    const fallback = setTimeout(fire, 700);
    window.addEventListener("scrollend", fire);
  }

  // Flash a translucent yellow box over the question, then remove it. Anchored
  // to the document (rect + scroll offset) so it sits over the target.
  function flashHighlight(target) {
    // Only ever one overlay at a time. Each overlay is translucent, so clicking
    // repeatedly would otherwise stack layers that compound into an ever-darker
    // box that hides the question. Removing any in-flight overlay first keeps
    // the yellow a single, consistent shade no matter how many times you click.
    document.querySelectorAll(".ez-verifier-flash").forEach((el) => el.remove());
    const rect = target.getBoundingClientRect();
    const flash = document.createElement("div");
    flash.className = "ez-verifier-flash";
    flash.style.top = rect.top + window.scrollY - 2 + "px";
    flash.style.left = rect.left + window.scrollX - 2 + "px";
    flash.style.width = rect.width + 4 + "px";
    flash.style.height = rect.height + 4 + "px";
    (document.body || document.documentElement).appendChild(flash);
    flash.addEventListener("animationend", () => flash.remove());
    setTimeout(() => flash.remove(), 2000); // safety net if animationend misses
  }

  // ---------- helpers ----------

  function isVisible(el) {
    if (!el) return false;
    // Walk up; if any ancestor table/group is display:none, treat as hidden.
    let node = el;
    while (node && node !== document.body) {
      const cs = window.getComputedStyle(node);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      node = node.parentElement;
    }
    return true;
  }

  function text(el) {
    return (el ? el.textContent : "").replace(/\s+/g, " ").trim();
  }

  // Derive a stable field key from an id like "Main_21_StreetSign_Control" -> "21_StreetSign"
  function fieldKeyFromId(id) {
    if (!id) return null;
    let m = id.match(/^Main_(.+?)_(Label|Control)$/);
    if (m) return m[1];
    return null;
  }

  // ---------- scraping questions ----------

  function scrapeQuestions() {
    const panel = document.getElementById("Main_PanelMain");
    if (!panel) return { sections: [] };

    // All FieldGroup tables in document order (flat siblings).
    const groups = Array.from(panel.querySelectorAll("table.FieldGroup"));

    const sections = [];
    let current = null;

    for (const group of groups) {
      const caption = group.querySelector("td.FieldGroupCaption > span, td.FieldGroupCaption span");
      const captionCell = group.querySelector("td.FieldGroupCaption");

      // A caption table starts a new section.
      if (captionCell) {
        const title = text(caption) || text(captionCell);
        current = { header: title, questions: [] };
        sections.push(current);
        // A caption table can ALSO contain a question row (e.g. Inspection Notes).
        // Fall through to also parse any label/control in the same table.
      }

      if (!current) {
        // Question before any caption - bucket into an "Ungrouped" section.
        current = { header: "(Ungrouped)", questions: [] };
        sections.push(current);
      }

      // Find label + control cells in this group.
      const labelCell = group.querySelector("td.FieldLabelHighlight");
      const controlCell = group.querySelector("td.FieldControl");
      if (!labelCell || !controlCell) continue;

      const labelText = text(labelCell.querySelector(".labelNameFormat")) || text(labelCell);
      if (!labelText) continue;

      // Skip hidden questions (conditional fields not currently shown).
      if (!isVisible(controlCell)) continue;

      const fieldKey =
        fieldKeyFromId(controlCell.id) ||
        fieldKeyFromId(labelCell.id) ||
        ("q_" + sections.length + "_" + current.questions.length);

      const parsed = parseControl(controlCell);
      if (!parsed) continue;

      current.questions.push({
        id: fieldKey,
        text: labelText,
        type: parsed.type,
        options: parsed.options,
        currentAnswer: parsed.currentAnswer,
      });
    }

    // Drop empty sections (caption-only with no visible questions).
    return { sections: sections.filter((s) => s.questions.length > 0) };
  }

  // Parse a FieldControl cell into {type, options, currentAnswer}.
  function parseControl(cell) {
    // Inline radio group: <span><input type=radio>...</span>
    const radios = Array.from(cell.querySelectorAll('input[type="radio"]'));
    if (radios.length > 0) {
      const options = [];
      let currentAnswer = null;
      for (const r of radios) {
        const lbl = cell.querySelector(`label[for="${r.id}"]`);
        const val = r.value || text(lbl);
        options.push(val);
        if (r.checked) currentAnswer = val;
      }
      return { type: "radio", options, currentAnswer };
    }

    // Checkbox list (multi-select), e.g. "Vacancy Determined By (Choose at least
    // 3)". The answer is the SET of checked labels. This must come before the
    // text-input branch below, or the page's hidden CheckBoxListValidation input
    // would be read instead (showing the internal "6|2|Lawn" codes).
    const checkboxes = Array.from(cell.querySelectorAll('input[type="checkbox"]'));
    if (checkboxes.length) {
      const options = [];
      const selected = [];
      for (const cb of checkboxes) {
        const lbl = cell.querySelector(`label[for="${cb.id}"]`);
        const val = text(lbl) || cb.value;
        if (!val) continue;
        options.push(val);
        if (cb.checked) selected.push(val);
      }
      return { type: "checkbox", options, currentAnswer: selected };
    }

    // Select dropdown
    const sel = cell.querySelector("select");
    if (sel) {
      const options = Array.from(sel.options).map((o) => o.text.trim());
      return { type: "select", options, currentAnswer: sel.value ? sel.options[sel.selectedIndex].text.trim() : null };
    }

    // Textarea / text input
    const ta = cell.querySelector("textarea");
    if (ta) {
      return { type: "text", options: [], currentAnswer: (ta.value || "").trim() };
    }
    const inp = cell.querySelector('input[type="text"], input[type="number"]');
    if (inp) {
      return { type: "text", options: [], currentAnswer: (inp.value || "").trim() };
    }

    return null;
  }

  // ---------- scraping photos ----------

  // Thumbnails look like .../I330890154/thumbnail/<file>.jpg?_dt=...  Dropping
  // the "/thumbnail" segment names the full-size file, but that file only
  // EXISTS once EZ has generated it, which it does lazily the first time the
  // photo is opened through JobPictureViewer.aspx / downloadUtil.aspx. Until
  // then this URL 404s, so it is only a fallback: resolveSourceUrl() drives the
  // viewer flow that generates the file and returns its real URL.
  function fullResFromThumb(url) {
    if (!url) return url;
    return url.replace("/thumbnail/", "/");
  }

  // Each thumbnail anchor is
  //   href="javascript:openPicture('<file>','<type>','<key>','<JID>')"
  // and clicking it opens the picture-detail page
  //   /inspManager/JobPictureViewer.aspx?file=<file>&type=<type>&key=<key>&JID=<JID>
  // which carries the EXIF "Taken On" date (span#Main_LabelTakenOn). We parse the
  // four args straight from the anchor (the key/JID are per-photo) and rebuild
  // that URL so the date can be fetched without opening a window.
  function pictureUrlFromAnchor(a) {
    if (!a) return null;
    const raw = a.getAttribute("href") || a.getAttribute("onclick") || "";
    const m = raw.match(/openPicture\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/);
    if (!m) return null;
    const [, file, type, key, jid] = m;
    const qs = new URLSearchParams({ file, type, key, JID: jid }).toString();
    try {
      return new URL("/inspManager/JobPictureViewer.aspx?" + qs, location.origin).href;
    } catch (e) {
      return null;
    }
  }

  function scrapePhotos() {
    const photos = [];
    // Each photo cell contains a span[attid] with a Photo label, an <img>, and a
    // category <select>. Iterate over the attid-bearing spans (most robust).
    const attSpans = Array.from(document.querySelectorAll("span[attid]"));
    for (const span of attSpans) {
      const attid = span.getAttribute("attid");
      if (!attid) continue;

      // Skip non-photo attachments (Order Documents also use span[attid] but live under DataListCover).
      const inPhotoBlock = span.closest('table[id^="Main_RepeaterPic_DataListPic_"]');
      if (!inPhotoBlock) continue;

      const td = span.closest("td");
      const labelEl = span.querySelector("label");
      const photoLabel = text(labelEl) || ("Photo " + attid);

      const img = td ? td.querySelector('img[id*="ImageAtt"]') : null;
      const thumbUrl = img ? img.src : null;

      const sel = td ? td.querySelector("select.stageClass, select[id*='DropDownStage']") : null;
      let category = null;
      if (sel && sel.selectedIndex >= 0) category = sel.options[sel.selectedIndex].text.trim();

      // The picture-detail URL (for the "Taken On" date) comes from the thumbnail's
      // openPicture(...) anchor - the img is wrapped in <a class="thumb">.
      const anchor =
        (img && img.closest('a[href*="openPicture"], a.thumb')) ||
        (td && td.querySelector('a[href*="openPicture"], a.thumb'));

      photos.push({
        ref: "att_" + attid,
        attid,
        label: photoLabel,
        category,
        thumbnailUrl: thumbUrl,
        fullResUrl: fullResFromThumb(thumbUrl),
        pictureUrl: pictureUrlFromAnchor(anchor),
        filename: thumbUrl ? thumbUrl.split("/").pop().split("?")[0] : attid + ".jpg",
      });
    }
    return photos;
  }

  // ---------- applying an answer back to the page ----------

  function locateField(fieldKey) {
    // The element used to apply/focus a field, resolved a few different ways.
    const groupName = "ctl00$Main$" + fieldKey;
    const radio = document.querySelector(
      `input[type="radio"][name="${CSS.escape(groupName)}"]`
    );
    if (radio) return radio;
    const byId = document.getElementById("Main_" + fieldKey);
    if (byId) return byId;
    // Last resort: any element whose id mentions the key under the Main panel.
    return document.querySelector(`[id^="Main_"][id*="${CSS.escape(fieldKey)}"]`);
  }

  function applyAnswer(fieldKey, value) {
    // Radio
    const groupName = "ctl00$Main$" + fieldKey;
    const radios = Array.from(
      document.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`)
    );
    if (radios.length) {
      for (const r of radios) {
        if (r.value === value) {
          r.checked = true;
          r.click(); // fires the page's onChange/highlight handlers
          return { ok: true, applied: value };
        }
      }
      return { ok: false, error: "value not found in radio group" };
    }

    // Checkbox list (multi-select): check/uncheck each box so the page's checked
    // set matches the desired labels. value is an array of labels (a string
    // fallback is split on "|" or ","). Clicking fires the page's onChange/colour.
    const cbContainer = document.getElementById("Main_" + fieldKey);
    const checkboxes = cbContainer
      ? Array.from(cbContainer.querySelectorAll('input[type="checkbox"]'))
      : [];
    if (checkboxes.length) {
      const wanted = Array.isArray(value) ? value : String(value).split(/\s*[|,]\s*/);
      const wantSet = new Set(wanted.map((s) => String(s).replace(/\s+/g, " ").trim().toLowerCase()));
      for (const cb of checkboxes) {
        const lbl = document.querySelector(`label[for="${cb.id}"]`);
        const labelText = (lbl ? lbl.textContent : "").replace(/\s+/g, " ").trim().toLowerCase();
        const shouldCheck = wantSet.has(labelText);
        if (cb.checked !== shouldCheck) cb.click();
      }
      return { ok: true, applied: value };
    }

    // Select
    const sel = document.getElementById("Main_" + fieldKey);
    if (sel && sel.tagName === "SELECT") {
      for (const o of sel.options) {
        if (o.text.trim() === value || o.value === value) {
          sel.value = o.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, applied: value };
        }
      }
    }

    // Textarea / input
    const ta = document.getElementById("Main_" + fieldKey);
    if (ta && (ta.tagName === "TEXTAREA" || ta.tagName === "INPUT")) {
      ta.value = value;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: true, applied: value };
    }

    return { ok: false, error: "field not found: " + fieldKey };
  }

  // ---------- focus + highlight a question (click-to-locate) ----------

  // Remove any in-flight flash overlay (e.g. on a CLEAR_HIGHLIGHT message).
  function clearHighlight() {
    document.querySelectorAll(".ez-verifier-flash").forEach((el) => el.remove());
  }

  function focusQuestion(fieldKey) {
    const el = locateField(fieldKey);
    if (!el) return { ok: false, error: "field not found: " + fieldKey };

    // Highlight the whole FieldGroup table if we can find it, else the control's row.
    const target =
      el.closest("table.FieldGroup") ||
      el.closest("tr") ||
      el.closest("td") ||
      el;

    ensureHighlightStyle();

    // Scroll the question into view, then flash a yellow box over it - no
    // persistent highlight stays behind.
    scrollThenFlash(target);

    return { ok: true };
  }

  // ---------- property address ----------

  // The page title span holds e.g.
  //   "22531 JOHN ROLFE LN, Katy, TX, 77449 (13511164) (Sys ID 330919755)"
  // Return just the street address, dropping the trailing parenthetical IDs.
  function scrapeAddress() {
    const span = document.getElementById("Main_LabelTitleAddress");
    if (!span) return null;
    const raw = text(span);
    if (!raw) return null;
    // Strip the first " (" and everything after it (the (id) (Sys ID …) suffix).
    const cut = raw.split(/\s*\(/)[0].trim();
    return cut || raw;
  }

  // ---------- work code ----------
  // The page title span holds e.g.
  //   "Cyprexx Occupancy Verification Inspection  (4606603)"
  // We match the title against a known list of work codes. The title may carry
  // extra words at the front or the end (or a trailing parenthetical id), so we
  // look for a known code as an exact (case-insensitive) substring. On a match
  // we return the canonical code; otherwise we return null so downstream
  // consumers can tell the code couldn't be identified.
  const KNOWN_WORK_CODES = [
    "Cyprexx Occupancy Verification Inspection",
    "Cyprexx Aspen Grove V2 Property Condition",
    "Cyprexx Sales Date Inspection Instructions",
    "M&T Door Knock Inspection",
    "Foreclosure (Contact)",
    "CONTACT INSPECTION",
    "Cyprexx Aspen Grove V2 REO",
    "Cyprexx Interior/Exterior",
    "Vacancy Task",
    "NFR-WT2",
  ];

  function matchWorkCode(raw) {
    if (!raw) return null;
    const haystack = raw.replace(/\s+/g, " ").trim().toLowerCase();
    for (const code of KNOWN_WORK_CODES) {
      const needle = code.replace(/\s+/g, " ").trim().toLowerCase();
      if (haystack.includes(needle)) return code;
    }
    return null;
  }

  function scrapeWorkCode() {
    const span = document.getElementById("Main_LabelTitle");
    if (!span) return null;
    return matchWorkCode(text(span));
  }

  // The job identifier is the Work Order number shown on the page
  // (span#Main_LabelWorkOrder), e.g. "13519930". Fall back to the URL's Id=
  // param if the label isn't present yet (form still rendering / older layout).
  function getJobId() {
    const wo = text(document.getElementById("Main_LabelWorkOrder"));
    if (wo) return wo;
    return (location.search.match(/Id=(\d+)/i) || [])[1] || null;
  }

  // ---------- photo-date check (stale photos) ----------
  // Every photo of a job should be taken on the day the inspection was completed.
  // Compare each photo's "Taken On" EXIF date (fetched from its JobPictureViewer
  // page) against the job's "Completed Date Time"; any photo taken on a different
  // day is flagged as stale.
  //
  // Two dates, two formats:
  //   Completed Date Time  span#Main_LabelCompleteDateTime  "06/25 12:58 PM  PST"
  //     -> month/day only, NO year, in PST.
  //   Taken On             span#Main_LabelTakenOn           "6/25/2026 5:12 PM"
  //     -> month/day/year.
  // Because the completed date carries no year (and a different time zone), the
  // only sound comparison is at DAY granularity: month + day.

  // The "Completed Date Time" label; if the site renames the field, update this id.
  const COMPLETED_DATE_ID = "Main_LabelCompleteDateTime";

  function completedDate() {
    const raw = text(document.getElementById(COMPLETED_DATE_ID));
    const m = raw.match(/(\d{1,2})\s*\/\s*(\d{1,2})/); // MM/DD (year absent)
    if (!m) return null;
    return { month: +m[1], day: +m[2], raw };
  }

  // EZ fills the Completed Date Time label AFTER the form appears, so on a slow
  // load it can still be empty the first time we read it - which used to make the
  // whole photo-date check silently disappear. Poll briefly (only while the label
  // is present but blank) so we wait out that population instead of giving up.
  async function completedDateReady(timeoutMs = 6000, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const c = completedDate();
      if (c) return c;
      // The label element is absent entirely (not this page) - nothing to wait for.
      if (!document.getElementById(COMPLETED_DATE_ID)) return null;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  function parseTakenOn(raw) {
    const m = (raw || "").match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/); // M/D/YYYY
    if (!m) return null;
    return { month: +m[1], day: +m[2], year: +m[3] };
  }

  // Fetch a photo's JobPictureViewer page and read span#Main_LabelTakenOn. Runs in
  // the page origin, so the session cookie rides along and the parse is same-site.
  async function fetchTakenOn(url) {
    if (!url) return null;
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return null;
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const t = text(doc.getElementById("Main_LabelTakenOn"));
      return t || null;
    } catch (e) {
      return null;
    }
  }

  async function checkPhotoDates() {
    const completed = await completedDateReady();
    const photos = scrapePhotos();
    const out = {
      completedDate: completed ? completed.raw : null,
      completedDay: completed ? `${completed.month}/${completed.day}` : null,
      total: photos.length,
      withDate: 0,
      noDate: 0,
      stale: [],
    };
    if (!completed) return out; // no date to compare against - panel hides the flag

    // Fetch the picture pages with bounded concurrency (each is a full HTML page).
    const CONCURRENCY = 5;
    let cursor = 0;
    const worker = async () => {
      while (cursor < photos.length) {
        const p = photos[cursor++];
        const rawTaken = await fetchTakenOn(p.pictureUrl);
        const taken = parseTakenOn(rawTaken);
        if (!taken) {
          out.noDate++;
          continue;
        }
        out.withDate++;
        if (taken.month !== completed.month || taken.day !== completed.day) {
          out.stale.push({
            attid: p.attid,
            label: p.label,
            category: p.category,
            takenOn: rawTaken,
            thumbnailUrl: p.thumbnailUrl,
            fullResUrl: p.fullResUrl,
            pictureUrl: p.pictureUrl,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, photos.length) }, worker)
    );
    return out;
  }

  // ---------- detection (lightweight snapshot for the side panel) ----------

  function detect() {
    const jobId = getJobId();
    const panel = document.getElementById("Main_PanelMain");
    const supported = !!panel;
    const { sections } = scrapeQuestions();
    const questionCount = sections.reduce((n, s) => n + s.questions.length, 0);
    const photoCount = scrapePhotos().length;
    return {
      ok: true,
      supported,
      jobId,
      url: location.href,
      address: scrapeAddress(),
      questionCount,
      photoCount,
    };
  }

  // ---------- message handling ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "DETECT") {
      sendResponse(detect());
      return true;
    }

    if (msg.type === "SCRAPE") {
      const jobId = getJobId();
      const data = {
        jobId,
        url: location.href,
        address: scrapeAddress(),
        workCode: scrapeWorkCode(),
        completedDate: (completedDate() || {}).raw || null,
        ...scrapeQuestions(),
        photos: scrapePhotos(),
      };
      sendResponse({ ok: true, data });
      return true;
    }

    if (msg.type === "CHECK_PHOTO_DATES") {
      checkPhotoDates()
        .then((result) => sendResponse({ ok: true, result }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true; // async response
    }

    if (msg.type === "APPLY_ANSWER") {
      const result = applyAnswer(msg.fieldKey, msg.value);
      sendResponse(result);
      return true;
    }

    if (msg.type === "FOCUS_QUESTION") {
      sendResponse(focusQuestion(msg.fieldKey));
      return true;
    }

    if (msg.type === "CLEAR_HIGHLIGHT") {
      clearHighlight();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === "SHOW_IMAGE_MODAL") {
      try {
        if (window.EZ_IMAGE_MODAL && typeof window.EZ_IMAGE_MODAL.show === "function") {
          window.EZ_IMAGE_MODAL.show(msg.images || [], msg.index || 0);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "image viewer not loaded" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return true;
    }

    if (msg.type === "PING") {
      sendResponse({ ok: true, pong: true });
      return true;
    }
  });

  // ---------- announce readiness (auto-detect, no manual refresh) ----------
  // When the operator opens or navigates to a job page while the side panel is
  // already open, the panel's last detect() may have run too early (or on the
  // previous page). So the content script proactively tells the panel the moment
  // the inspection form is present; the panel re-detects on that signal.

  let announced = false;
  function announceReady() {
    if (announced) return;
    announced = true;
    const jobId = getJobId();
    try {
      chrome.runtime.sendMessage({ type: "EZ_PAGE_READY", jobId, url: location.href });
    } catch (e) {
      // No receiver (panel closed) - harmless; the panel detects when it opens.
    }
  }

  function watchForForm() {
    // Already rendered → announce immediately.
    if (document.getElementById("Main_PanelMain")) {
      announceReady();
      return;
    }
    // Otherwise the form may appear after this script runs (slow load / a
    // postback). Watch the DOM and announce as soon as it shows up, once.
    const obs = new MutationObserver(() => {
      if (document.getElementById("Main_PanelMain")) {
        obs.disconnect();
        announceReady();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // Stop watching after 20s so we never leave a perpetual observer running.
    setTimeout(() => obs.disconnect(), 20000);
  }

  watchForForm();
})();
