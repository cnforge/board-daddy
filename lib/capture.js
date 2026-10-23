'use strict';
// Board Daddy capture engine. Runs in Electron's main process.
// Every page is rendered in a hidden Chromium window at its native CSS size and
// captured through the DevTools protocol, so output is full resolution
// (optionally 2x retina) with no screenshot size cap and no stitching.

const { BrowserWindow, session, nativeImage } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Replace animated GIFs with a single frozen frame so captures are consistent.
const FREEZE_GIFS = `(async()=>{let n=0;for(const i of document.querySelectorAll('img')){
  if(/\\.gif/i.test(i.currentSrc||i.src)&&i.naturalWidth){try{const c=document.createElement('canvas');
  c.width=i.naturalWidth;c.height=i.naturalHeight;c.getContext('2d').drawImage(i,0,0);
  i.src=c.toDataURL('image/png');n++}catch(e){}}}
  await new Promise(r=>setTimeout(r,500));return n})()`;

const CLICK_NEXT = `(()=>{const sels=['[aria-label*="next" i]','[title*="next" i]','[data-testid*="next" i]',
  '.swiper-button-next','.slick-next','[class*="next" i]','[id*="next" i]','[class*="arrow" i][class*="right" i]','.arrow-right'];
  for(const s of sels){const els=[...document.querySelectorAll(s)].filter(e=>{const r=e.getBoundingClientRect();
  return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&!e.disabled});
  if(els.length){els[0].click();return s}}return null})()`;

const PAGE_TEXT = `(()=>{try{return (document.body.innerText||'').trim()}catch(e){return ''}})()`;
const DOC_SIZE = `(()=>{const d=document.documentElement,b=document.body;
  return [Math.max(d.scrollWidth,b?b.scrollWidth:0),Math.max(d.scrollHeight,b?b.scrollHeight:0)]})()`;
const AUTOSCROLL = `(async()=>{const h=()=>Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);
  let y=0;for(let i=0;i<80&&y<h();i++){y+=Math.round(innerHeight*0.8);scrollTo(0,y);await new Promise(r=>setTimeout(r,250))}
  await new Promise(r=>setTimeout(r,600));scrollTo(0,0);await new Promise(r=>setTimeout(r,400));return h()})()`;

// Password gates. The password comes from the user's own input field; it is only
// typed into the page's password box and is never logged or written to disk.
const DEEP = `const deep=(sel,root)=>{root=root||document;const out=[...root.querySelectorAll(sel)];
  for(const el of root.querySelectorAll('*')){if(el.shadowRoot)out.push(...deep(sel,el.shadowRoot))}return out};
  const vis=(e)=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};
  const gateInput=(broad)=>{const pw=deep('input[type=password]').find(vis);if(pw||!broad)return pw;
    // Some sites (Pitch, for one) use a plain text box labelled "Passcode"/"Password".
    return deep('input').find(e=>{const t=(e.type||'text').toLowerCase();if(!/^(text|search|tel|number)$/.test(t)||!vis(e))return false;
      const label=e.labels?[...e.labels].map(l=>l.innerText).join(' '):'';
      const hay=[e.placeholder,e.name,e.id,e.getAttribute('aria-label'),e.autocomplete,e.getAttribute('data-testid'),label].join(' ');
      return /pass\\s?(word|code|phrase)?|\\bpin\\b/i.test(hay)})};`;
// "broad" also matches text boxes labelled like a password; used only when the user supplied one.
const HAS_GATE = (broad) => `(()=>{${DEEP}return !!gateInput(${!!broad})})()`;
// Focus the box so real keystrokes can be typed into it.
const FOCUS_GATE = `(()=>{${DEEP}const i=gateInput(true);if(!i)return false;i.focus();if(i.select)i.select();return true})()`;
// Fallback: set the value programmatically (works for plain forms) and click submit.
const FILL_GATE = `(pw)=>{${DEEP}const inp=gateInput(true);if(!inp)return 'none';
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(inp,pw);
  inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));
  const scope=inp.closest('form')||inp.getRootNode();
  const btn=scope.querySelector('button[type=submit],input[type=submit]')||
    [...scope.querySelectorAll('button,[role=button],input[type=button]')].find(b=>/submit|enter|unlock|view|continue|open|go|sign|log/i.test((b.innerText||b.value||b.getAttribute('aria-label')||'')))||
    scope.querySelector('button');
  if(btn){btn.click();return 'clicked'}
  if(inp.form&&inp.form.requestSubmit){inp.form.requestSubmit();return 'submitted'}
  return 'none'}`;

const ADOBE_RE = /(https?:\/\/[^/]+\/content\/.+?\/package\/[^/]+\/)publication(?:-\d+)?\.html/;

async function createCaptureWindow(w, h, partition, ctx) {
  ctx = ctx || {};
  const password = ctx.password;
  const win = new BrowserWindow({
    show: false, width: w, height: h, useContentSize: true,
    webPreferences: {
      // Offscreen rendering keeps painting regardless of display state, so
      // captures work without a visible window and never flash on screen.
      offscreen: true,
      partition, backgroundThrottling: false, contextIsolation: true,
      sandbox: true, nodeIntegration: false,
    },
  });
  const wc = win.webContents;
  wc.setFrameRate(30);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  wc.setAudioMuted(true);
  win._password = password || '';
  win._emit = ctx._emit;
  win._ctx = ctx;
  // A page that needs a password can render its prompt late (single-page apps), so
  // the first load waits for it; later loads in the same session do not.
  win._gateWait = password ? (ctx._unlocked ? 5000 : 12000) : 0;
  // HTTP basic-auth prompts: use the password with an empty username.
  wc.on('login', (event, _req, _auth, callback) => {
    event.preventDefault();
    if (win._password) callback('', win._password); else callback();
  });
  // The DevTools emulation calls crash if used before the first navigation.
  await win.loadURL('about:blank').catch(() => {});
  try { wc.debugger.attach('1.3'); } catch (e) { /* capturePage fallback is used */ }
  return win;
}

async function setMetrics(wc, w, h, scale) {
  const owner = BrowserWindow.fromWebContents(wc);
  if (owner) owner._metrics = [w, h, scale];
  try {
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: scale, mobile: false,
    });
  } catch (e) { /* ignore */ }
}

async function shot(wc, clip) {
  try {
    const params = { format: 'png', fromSurface: true };
    if (clip) { params.captureBeyondViewport = true; params.clip = { ...clip, scale: 1 }; }
    const r = await wc.debugger.sendCommand('Page.captureScreenshot', params);
    return Buffer.from(r.data, 'base64');
  } catch (e) {
    const img = await wc.capturePage();
    return img.toPNG();
  }
}

function sig(png) {
  return nativeImage.createFromBuffer(png).resize({ width: 48, height: 27, quality: 'good' }).toBitmap();
}
function diff(a, b) {
  const x = sig(a), y = sig(b);
  const n = Math.min(x.length, y.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(x[i] - y[i]);
  return s / n;
}

// Capture until two consecutive frames match (handles transitions/animations).
async function settleShot(wc, clip) {
  let prev = await shot(wc, clip);
  for (let i = 0; i < 4; i++) {
    await sleep(450);
    const next = await shot(wc, clip);
    if (diff(prev, next) < 0.8) return next;
    prev = next;
  }
  return prev;
}

function thumbOf(png) {
  const img = nativeImage.createFromBuffer(png).resize({ width: 480, quality: 'good' });
  return 'data:image/jpeg;base64,' + img.toJPEG(65).toString('base64');
}

// Status line for the UI, optionally with a snapshot of what the hidden browser sees.
async function note(win, msg, withThumb) {
  if (!win._emit) return;
  let thumb;
  if (withThumb) { try { thumb = thumbOf(await shot(win.webContents)); } catch (e) { /* ignore */ } }
  win._emit({ phase: 'detect', msg, thumb });
}

async function findGate(wc, broad) {
  for (const f of wc.mainFrame.framesInSubtree) {
    try { if (await f.executeJavaScript(HAS_GATE(broad))) return f; } catch (e) { /* frame not ready */ }
  }
  return null;
}

async function gateGone(wc, ms, broad) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(600);
    if (!(await findGate(wc, broad))) return true;
  }
  return false;
}

async function passGate(win, password, waitMs) {
  const wc = win.webContents;
  let frame = null;
  const t0 = Date.now();
  for (;;) {
    frame = await findGate(wc, !!password);
    if (frame || !password || Date.now() - t0 >= (waitMs || 0)) break;
    await sleep(500);
  }
  if (!frame) return false;
  if (!password) throw new Error('This link is password protected. Enter the password in the Password field and try again.');

  await note(win, 'Password box found, entering password…', true);
  // 1) Type it the way a person would (real keystrokes), then press Enter.
  try {
    wc.focus();
    await frame.executeJavaScript(FOCUS_GATE);
    await wc.insertText(password);
    await sleep(250);
    for (const t of ['rawKeyDown', 'char', 'keyUp']) wc.sendInputEvent({ type: t, keyCode: 'Return' });
  } catch (e) { /* fall through to the next method */ }
  if (await gateGone(wc, 6000, true)) { await note(win, 'Password accepted.'); await sleep(1500); return true; }

  // 2) Fallback: set the field directly and click the page's own submit button.
  frame = await findGate(wc, true);
  if (frame) {
    try { await frame.executeJavaScript(`(${FILL_GATE})(${JSON.stringify(password)})`); } catch (e) { /* ignore */ }
    if (await gateGone(wc, 6000, true)) { await note(win, 'Password accepted.'); await sleep(1500); return true; }
  } else { await note(win, 'Password accepted.'); await sleep(1500); return true; }

  await note(win, 'The page is still asking for the password:', true);
  throw new Error('The password was not accepted. Check it and try again (the preview shows what the page is showing).');
}

async function load(win, url, settleMs) {
  await Promise.race([win.loadURL(url).catch(() => {}), sleep(45000)]);
  await sleep(1200);
  const wait = win._gateWait || 0;
  win._gateWait = 0;
  if (await passGate(win, win._password, wait)) win._ctx._unlocked = true;
  if (win._metrics) await setMetrics(win.webContents, ...win._metrics);
  await sleep(settleMs);
}

function pngSize(png) {
  const s = nativeImage.createFromBuffer(png).getSize();
  return s;
}

// ---------- Adobe Publish Online ----------
async function discoverAdobe(url, opts) {
  const win = await createCaptureWindow(1280, 720, opts._part, opts);
  const wc = win.webContents;
  const found = [];
  wc.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (d) => {
    const m = ADOBE_RE.exec(d.url);
    if (m && !found.includes(m[1])) found.push(m[1]);
  });
  try {
    await Promise.race([win.loadURL(url).catch(() => {}), sleep(30000)]);
    const t0 = Date.now();
    while (!found.length && Date.now() - t0 < 40000) {
      await sleep(700);
      // The password prompt can appear a few seconds after the page loads.
      if (await passGate(win, opts.password, 0)) { opts._unlocked = true; }
    }
    if (!found.length) {
      for (const f of wc.mainFrame.framesInSubtree) {
        const m = ADOBE_RE.exec(f.url);
        if (m) found.push(m[1]);
      }
    }
    if (!found.length) await note(win, 'Could not find the publication pages. This is what the page shows:', true);
    return { base: found[0], title: wc.getTitle() };
  } finally { win.destroy(); }
}

async function urlExists(u, partition) {
  try { const r = await session.fromPartition(partition).fetch(u); return r.ok; } catch (e) { return false; }
}

async function runAdobe(opts, emit, cancelled) {
  emit({ phase: 'detect', msg: 'Finding the publication pages…' });
  const { base, title } = await discoverAdobe(opts.url, opts);
  if (!base) return null;
  opts._unlocked = true;
  const urls = [];
  for (let n = 1; n <= opts.maxPages; n++) {
    const u = base + (n === 1 ? 'publication.html' : `publication-${n - 1}.html`);
    if (!(await urlExists(u, opts._part))) break;
    urls.push(u);
    emit({ phase: 'detect', msg: `Found ${urls.length} pages…` });
    if (cancelled()) return { title, pages: [] };
  }
  if (!urls.length) return null;

  let w = opts.width, h = opts.height;
  const win = await createCaptureWindow(w, h, opts._part, opts);
  const wc = win.webContents;
  const pages = [];
  try {
    for (let i = 0; i < urls.length; i++) {
      if (cancelled()) break;
      await setMetrics(wc, w, h, opts.scale);
      await load(win, urls[i], opts.settleMs);
      if (i === 0 && opts.autoSize) {
        const [sw, sh] = await wc.executeJavaScript(DOC_SIZE);
        if ((sw > w + 2 || sh > h + 2) && sw >= 640 && sh >= 360 && sw <= 4000 && sh <= 4000) {
          w = sw; h = sh;
          await setMetrics(wc, w, h, opts.scale);
          await sleep(600);
        }
      }
      try { await wc.executeJavaScript(FREEZE_GIFS); } catch (e) { /* ignore */ }
      const png = await settleShot(wc);
      const text = opts.wantText ? await wc.executeJavaScript(PAGE_TEXT).catch(() => '') : '';
      pages.push({ png, w, h, text });
      emit({ phase: 'capture', current: i + 1, total: urls.length, msg: `Captured page ${i + 1} of ${urls.length}`, thumb: thumbOf(png) });
    }
  } finally { win.destroy(); }
  return { title, pages };
}

// ---------- Generic page-by-page viewers ----------
async function advance(wc, prevShot, settleMs) {
  const keys = (code) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: code });
    if (code === 'Space') wc.sendInputEvent({ type: 'char', keyCode: ' ' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: code });
  };
  const attempts = [
    () => keys('Right'),
    () => wc.executeJavaScript(CLICK_NEXT),
    () => keys('PageDown'),
    () => keys('Space'),
  ];
  wc.focus();
  for (const a of attempts) {
    try { await a(); } catch (e) { /* try next */ }
    await sleep(Math.max(700, settleMs / 2));
    const s = await settleShot(wc);
    if (diff(prevShot, s) > 2.0) return s;
  }
  return null;
}

async function runPaged(opts, emit, cancelled) {
  const { width: w, height: h } = opts;
  const win = await createCaptureWindow(w, h, opts._part, opts);
  const wc = win.webContents;
  const pages = [];
  try {
    await setMetrics(wc, w, h, opts.scale);
    emit({ phase: 'capture', current: 0, total: 0, msg: 'Loading page…' });
    await load(win, opts.url, opts.settleMs);
    await setMetrics(wc, w, h, opts.scale);
    // Safety net: never export a lock screen as if it were the deck.
    const firstText = await wc.executeJavaScript(PAGE_TEXT).catch(() => '');
    if (/requires a (pass(code|word))|(enter|type) (the |your )?pass(code|word)|password[- ]protected|protected with a pass/i.test(firstText.slice(0, 1500))) {
      await note(win, 'This page is still locked:', true);
      throw new Error(opts.password
        ? 'The page still shows a password prompt. The password may be wrong, or the prompt was not recognised (the preview shows the page).'
        : 'This link is password protected. Enter the password in the Password field and try again.');
    }
    const title = wc.getTitle();
    let cur = await settleShot(wc);
    const first = cur;
    for (;;) {
      const text = opts.wantText ? await wc.executeJavaScript(PAGE_TEXT).catch(() => '') : '';
      pages.push({ png: cur, w, h, text });
      emit({ phase: 'capture', current: pages.length, total: 0, msg: `Captured page ${pages.length}`, thumb: thumbOf(cur) });
      if (cancelled() || pages.length >= opts.maxPages) break;
      const next = await advance(wc, cur, opts.settleMs);
      if (!next) break;                              // nothing moved: last page
      if (pages.length > 1 && diff(first, next) < 1.5) break; // looped back to start
      cur = next;
    }
    return { title, pages };
  } finally { win.destroy(); }
}

// ---------- Generic long scrolling pages ----------
async function runScroll(opts, emit, cancelled, preloaded) {
  const w = opts.width, vh = Math.max(600, Math.round(w * 9 / 16));
  const win = await createCaptureWindow(w, vh, opts._part, opts);
  const wc = win.webContents;
  try {
    await setMetrics(wc, w, vh, opts.scale);
    emit({ phase: 'capture', current: 0, total: 0, msg: 'Loading page…' });
    await load(win, opts.url, opts.settleMs);
    emit({ phase: 'capture', current: 0, total: 0, msg: 'Scrolling to load images…' });
    const total = Math.min(await wc.executeJavaScript(AUTOSCROLL), 60000);
    const title = wc.getTitle();
    const chunk = vh;
    const n = Math.min(Math.ceil(total / chunk), opts.maxPages);
    const pages = [];
    const fullText = opts.wantText ? await wc.executeJavaScript(PAGE_TEXT).catch(() => '') : '';
    for (let i = 0; i < n; i++) {
      if (cancelled()) break;
      const height = Math.min(chunk, total - i * chunk);
      const png = await settleShot(wc, { x: 0, y: i * chunk, width: w, height });
      pages.push({ png, w, h: height, text: i === 0 ? fullText : '' });
      emit({ phase: 'capture', current: i + 1, total: n, msg: `Captured section ${i + 1} of ${n}`, thumb: thumbOf(png) });
    }
    return { title, pages };
  } finally { win.destroy(); }
}

// ---------- Auto-detect ----------
async function probeKind(opts) {
  const win = await createCaptureWindow(opts.width, opts.height, opts._part, opts);
  try {
    await setMetrics(win.webContents, opts.width, opts.height, 1);
    await load(win, opts.url, Math.min(opts.settleMs, 2500));
    const [, sh] = await win.webContents.executeJavaScript(DOC_SIZE);
    return sh > opts.height * 3 ? 'scroll' : 'paged';
  } finally { win.destroy(); }
}

async function runJob(rawOpts, emit, cancelled) {
  const opts = {
    mode: 'auto', width: 1920, height: 1080, scale: 1, maxPages: 300,
    settleMs: 2500, wantText: false, autoSize: true, password: '', ...rawOpts,
  };
  // One in-memory session per job so a login in one window carries to the next.
  opts._part = 'bd-job-' + Date.now();
  opts._emit = emit;
  if (!/^(https?|file):\/\//i.test(opts.url || '')) throw new Error('Please enter a full web address starting with http:// or https://');
  let mode = opts.mode;
  const isAdobe = /(^|\.)indd\.adobe\.com$/i.test(safeHost(opts.url));
  if (mode === 'auto') {
    if (isAdobe) mode = 'adobe';
    else { emit({ phase: 'detect', msg: 'Detecting page layout…' }); mode = await probeKind(opts); }
  }
  emit({ phase: 'detect', msg: `Mode: ${({ adobe: 'Adobe Publish Online', paged: 'Page-by-page viewer', scroll: 'Long scrolling page' })[mode]}` });

  let result = null;
  if (mode === 'adobe') {
    result = await runAdobe(opts, emit, cancelled);
    if (!result) {
      emit({ phase: 'detect', msg: 'Could not find Adobe page files, falling back to page-by-page capture…' });
      mode = 'paged';
    }
  }
  if (mode === 'paged') result = await runPaged(opts, emit, cancelled);
  else if (mode === 'scroll') result = await runScroll(opts, emit, cancelled);
  if (!result || !result.pages.length) throw new Error('No pages were captured.');
  return result;
}

function safeHost(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }

module.exports = { runJob, pngSize, createCaptureWindow, setMetrics, load, advance, settleShot, diff };
