// imageModal.js - on-page full-resolution image viewer for the EZ Inspections
// AI Verifier (ported from the NSR/SmartFill viewer).
//
// Renders ON the inspection page, not in the side panel, because the photos are
// served from ezinspections.com - same-origin with the page - so the logged-in
// session cookies load each image with no extra auth or proxying.
//
// Features: zoom (mouse wheel or + / − buttons), drag-to-pan when zoomed,
// prev/next gallery navigation (‹ › buttons or ← → keys), fit-to-screen
// (⤢ button or 0 key), and close (✕ button, Esc key, or backdrop click).
//
// Exposes window.EZ_IMAGE_MODAL.show(images, startIndex), where `images` is a
// URL string, a { full, thumb, picture } object, or an array of either (the
// gallery). `picture` is the photo's JobPictureViewer.aspx URL, used to resolve
// the true full-size image when the guessed full-res URL does not exist.

(() => {
  // Guard against double-injection (manifest match + on-demand executeScript).
  if (window.__ezImageModalLoaded) return;
  window.__ezImageModalLoaded = true;

  const NS = 'ezv-modal';
  const MIN = 1, MAX = 6, STEP = 0.25;

  let root = null, imgEl = null, counterEl = null;
  let gallery = [];
  let index = 0;
  let loadToken = 0;
  let scale = 1, tx = 0, ty = 0;
  let dragging = false, startX = 0, startY = 0, baseTx = 0, baseTy = 0;

  function injectStyles() {
    if (document.getElementById(NS + '-style')) return;
    const css = `
      .${NS}-root{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;}
      .${NS}-backdrop{position:absolute;inset:0;background:rgba(8,12,20,.86);}
      .${NS}-stage{position:relative;z-index:1;width:100%;height:100%;overflow:hidden;display:flex;align-items:center;justify-content:center;}
      .${NS}-img{max-width:92vw;max-height:88vh;user-select:none;-webkit-user-drag:none;transform-origin:center center;transition:transform .05s linear;cursor:grab;box-shadow:0 20px 60px rgba(0,0,0,.5);border-radius:4px;background:#0b0f17;}
      .${NS}-img.${NS}-dragging{cursor:grabbing;transition:none;}
      .${NS}-bar{position:absolute;z-index:2;left:50%;bottom:22px;transform:translateX(-50%);display:flex;align-items:center;gap:6px;background:rgba(17,24,39,.92);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:6px 8px;box-shadow:0 8px 30px rgba(0,0,0,.45);}
      .${NS}-btn{appearance:none;border:0;background:transparent;color:#e5e7eb;width:34px;height:34px;border-radius:999px;font-size:17px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;font-family:system-ui,Segoe UI,sans-serif;}
      .${NS}-btn:hover{background:rgba(255,255,255,.14);color:#fff;}
      .${NS}-counter{color:#cbd5e1;font:600 12px/1 system-ui,Segoe UI,sans-serif;min-width:54px;text-align:center;letter-spacing:.5px;}
      .${NS}-sep{width:1px;height:20px;background:rgba(255,255,255,.16);margin:0 2px;}
      .${NS}-close{position:absolute;z-index:2;top:18px;right:20px;width:40px;height:40px;border-radius:999px;background:rgba(17,24,39,.92);border:1px solid rgba(255,255,255,.12);color:#e5e7eb;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:system-ui,Segoe UI,sans-serif;}
      .${NS}-close:hover{background:rgba(255,255,255,.16);color:#fff;}
      .${NS}-nav{position:absolute;z-index:2;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:999px;background:rgba(17,24,39,.82);border:1px solid rgba(255,255,255,.12);color:#fff;font-size:26px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:system-ui,Segoe UI,sans-serif;}
      .${NS}-nav:hover{background:rgba(255,255,255,.18);}
      .${NS}-prev{left:18px;} .${NS}-next{right:18px;}
      .${NS}-nav:disabled{opacity:0;pointer-events:none;}
    `;
    const style = document.createElement('style');
    style.id = NS + '-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function build() {
    injectStyles();
    root = document.createElement('div');
    root.className = `${NS}-root`;
    root.innerHTML = `
      <div class="${NS}-backdrop"></div>
      <div class="${NS}-stage"><img class="${NS}-img" alt="" draggable="false" /></div>
      <button class="${NS}-close" title="Close (Esc)">✕</button>
      <button class="${NS}-nav ${NS}-prev" title="Previous (←)">‹</button>
      <button class="${NS}-nav ${NS}-next" title="Next (→)">›</button>
      <div class="${NS}-bar">
        <button class="${NS}-btn" data-act="zoomout" title="Zoom out (−)">−</button>
        <span class="${NS}-counter"></span>
        <button class="${NS}-btn" data-act="zoomin" title="Zoom in (+)">+</button>
        <span class="${NS}-sep"></span>
        <button class="${NS}-btn" data-act="fit" title="Fit to screen (0)">⤢</button>
      </div>`;
    document.body.appendChild(root);

    imgEl = root.querySelector(`.${NS}-img`);
    counterEl = root.querySelector(`.${NS}-counter`);

    root.querySelector(`.${NS}-backdrop`).addEventListener('click', close);
    root.querySelector(`.${NS}-close`).addEventListener('click', close);
    root.querySelector(`.${NS}-prev`).addEventListener('click', () => step(-1));
    root.querySelector(`.${NS}-next`).addEventListener('click', () => step(1));
    root.querySelectorAll(`.${NS}-btn`).forEach((b) => {
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'zoomin') zoom(STEP);
        else if (a === 'zoomout') zoom(-STEP);
        else if (a === 'fit') resetView();
      });
    });

    root.querySelector(`.${NS}-stage`).addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? STEP : -STEP);
    }, { passive: false });

    imgEl.addEventListener('mousedown', (e) => {
      if (scale <= 1) return;
      dragging = true; startX = e.clientX; startY = e.clientY; baseTx = tx; baseTy = ty;
      imgEl.classList.add(`${NS}-dragging`);
      e.preventDefault();
    });

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKey, true);
  }

  function onMove(e) {
    if (!dragging) return;
    tx = baseTx + (e.clientX - startX);
    ty = baseTy + (e.clientY - startY);
    apply();
  }
  function onUp() {
    dragging = false;
    if (imgEl) imgEl.classList.remove(`${NS}-dragging`);
  }
  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === '+' || e.key === '=') zoom(STEP);
    else if (e.key === '-' || e.key === '_') zoom(-STEP);
    else if (e.key === '0') resetView();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function apply() {
    imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }
  function resetView() { scale = 1; tx = 0; ty = 0; apply(); }
  function zoom(delta) {
    scale = Math.min(MAX, Math.max(MIN, +(scale + delta).toFixed(2)));
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  }

  // The static full-res guess (thumbnail URL minus /thumbnail/) 404s on EZ
  // servers that store photos under /tmpfiles/ - there the real full-size image
  // is only served by utility/downloadUtil.aspx with a per-session key that
  // appears on the photo's JobPictureViewer.aspx page. Fetch that page (same
  // origin, session cookie rides along) and read img#Main_Picture's src.
  // The resolved URL is cached on the gallery item for revisits.
  async function resolveFull(item) {
    if (!item || typeof item !== 'object' || !item.picture) return null;
    if (item.resolved) return item.resolved;
    try {
      const resp = await fetch(item.picture, { credentials: 'include' });
      if (!resp.ok) return null;
      const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
      const pic = doc.getElementById('Main_Picture');
      const src = pic && pic.getAttribute('src');
      if (!src) return null;
      item.resolved = new URL(src, resp.url || item.picture).href;
      return item.resolved;
    } catch (e) {
      return null;
    }
  }

  function setSrc(url, thumb) {
    imgEl.onerror = (thumb && thumb !== url)
      ? () => { imgEl.onerror = null; imgEl.src = thumb; }
      : null;
    imgEl.src = url;
  }

  function load() {
    resetView();
    // Gallery items are either a URL string or { full, thumb, picture }. Show
    // the best URL we already have (full-res guess, thumbnail fallback on
    // error), then resolve the true full-size URL from the picture-detail page
    // in the background and swap it in - the guessed full-res URL 404s on some
    // EZ servers, where the old behavior silently left the thumbnail up.
    const item = gallery[index];
    const token = ++loadToken;
    const full = typeof item === 'string' ? item : (item && (item.resolved || item.full)) || '';
    const thumb = item && typeof item === 'object' ? item.thumb || '' : '';
    setSrc(full || thumb || '', thumb);
    if (item && typeof item === 'object' && item.picture && !item.resolved) {
      resolveFull(item).then((url) => {
        if (!url || url === full || token !== loadToken || !root) return;
        setSrc(url, thumb);
      });
    }
    counterEl.textContent = `${index + 1} / ${gallery.length}`;
    const single = gallery.length <= 1;
    root.querySelector(`.${NS}-prev`).disabled = single;
    root.querySelector(`.${NS}-next`).disabled = single;
  }
  function step(dir) {
    if (gallery.length <= 1) return;
    index = (index + dir + gallery.length) % gallery.length;
    load();
  }

  function close() {
    if (!root) return;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    root.remove();
    root = null;
  }

  function show(images, startIndex) {
    gallery = (Array.isArray(images) ? images : [images]).filter(Boolean);
    if (!gallery.length) return;
    index = Math.max(0, Math.min(gallery.length - 1, startIndex || 0));
    if (root) close();
    build();
    load();
  }

  window.EZ_IMAGE_MODAL = { show, close };
})();
