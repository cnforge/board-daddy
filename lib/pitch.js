'use strict';
// Pitch media downloader: finds every image and video in a Pitch deck and saves the originals.
// The deck is opened in a hidden window that shares a persistent session with the
// "Sign in to Pitch" window, so private/editor links work once you have signed in.
// Media is collected two ways while stepping through the slides: from the network
// (every image/video the page loads) and from the page itself (img/video/background
// images/embeds). Each image is then fetched without resize parameters, keeping the
// largest version, so you get originals rather than thumbnails.

const { BrowserWindow, session, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const cap = require('./capture');
const yt = require('./ytdlp');

const PART = () => process.env.BD_PITCH_PARTITION || 'persist:pitch';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cancelled = false;
let child = null;

// Retry transient network failures (CDN hiccups, dropped connections) a couple of times.
async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (cancelled || /HTTP 4\d\d/.test(e.message)) break; await sleep(400 * (i + 1)); }
  }
  throw last;
}

function pitchSession() {
  const s = session.fromPartition(PART());
  // Look like plain Chrome: some sign-in pages refuse unknown embedded browsers.
  const ua = s.getUserAgent().replace(/\s(Electron|board-daddy|BoardDaddy|Board Daddy)\/\S+/gi, '');
  s.setUserAgent(ua);
  return s;
}

// ---------- sign in / out ----------
function signIn(parent, startUrl) {
  return new Promise((resolve) => {
    pitchSession();
    const w = new BrowserWindow({
      width: 1100, height: 820, parent, modal: false, title: 'Sign in to Pitch',
      webPreferences: { partition: PART(), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    let sawAuth = false;
    const check = (u) => {
      if (/auth\.pitch\.com|accounts\.google\.com|appleid\.apple\.com|\/login|\/sign/i.test(u)) sawAuth = true;
      else if (sawAuth && /^https:\/\/app\.pitch\.com\//.test(u)) setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 1500);
    };
    w.webContents.on('did-navigate', (_e, u) => check(u));
    w.webContents.setWindowOpenHandler(({ url }) => {
      // Google/Apple/SSO pop-ups must stay in the same session.
      return { action: 'allow', overrideBrowserWindowOptions: { parent: w, webPreferences: { partition: PART() } } };
    });
    w.on('closed', async () => resolve({ signedIn: await isSignedIn() }));
    w.loadURL(/^https:\/\/(app\.)?pitch\.com\//.test(startUrl || '') ? startUrl : 'https://app.pitch.com/app/');
  });
}

async function isSignedIn() {
  try {
    const cookies = await session.fromPartition(PART()).cookies.get({});
    return cookies.some((c) => /pitch\.com$/.test(c.domain.replace(/^\./, '')) && /\.is\.authenticated$/.test(c.name) && c.value === 'true');
  } catch (e) { return false; }
}

async function signOut() {
  await session.fromPartition(PART()).clearStorageData();
  return { signedIn: false };
}

// ---------- collecting ----------
// Runs inside every frame: lists images, videos, backgrounds and embeds.
const SCAN_DOM = `(()=>{const out=[];const deep=(root)=>{const all=[...root.querySelectorAll('*')];
  for(const el of [...all]){if(el.shadowRoot)all.push(...deep(el.shadowRoot))}return all};
  const abs=(u)=>{try{return new URL(u,location.href).href}catch(e){return null}};
  const best=(ss)=>{if(!ss)return null;let b=null,bw=-1;for(const part of ss.split(/,\\s+(?=\\S)/)){
    const [u,d]=part.trim().split(/\\s+/);const n=parseFloat(d)||1;if(n>bw){bw=n;b=u}}return b&&abs(b)};
  for(const el of deep(document)){
    const t=el.tagName;
    if(t==='IMG'){const r=el.getBoundingClientRect();
      for(const u of [best(el.srcset),el.currentSrc,el.src])if(u)out.push({kind:'image',url:abs(u),w:el.naturalWidth,h:el.naturalHeight,shown:r.width*r.height});}
    else if(t==='SOURCE'&&el.parentElement&&el.parentElement.tagName==='PICTURE'){const u=best(el.srcset);if(u)out.push({kind:'image',url:u});}
    else if(t==='VIDEO'){for(const u of [el.currentSrc,el.src,...[...el.querySelectorAll('source')].map(s=>s.src)])
      if(u)out.push({kind:'video',url:abs(u),w:el.videoWidth,h:el.videoHeight,poster:el.poster?abs(el.poster):null});
      if(el.poster)out.push({kind:'image',url:abs(el.poster),poster:true});}
    else if(t==='IFRAME'&&el.src){out.push({kind:'embed',url:abs(el.src)});}
    if(t!=='HTML'&&t!=='BODY'){const bg=getComputedStyle(el).backgroundImage;
      if(bg&&bg!=='none')for(const m of bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g))out.push({kind:'image',url:abs(m[1]),bg:true});}
  }
  return out.filter(x=>x.url&&!/^(data|about|javascript):/.test(x.url))})()`;

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)(\?|$)/i;
const HLS = /\.m3u8(\?|$)/i;
const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|heic|tiff?|bmp|svg)(\?|$)/i;
// UI chrome that is never deck content.
const SKIP = /(favicon|\/fonts?\/|\.woff2?|gravatar\.com|googleusercontent\.com\/a\/|\/avatars?\/|\/emoji|\/icons?\/|static\.pitch\.com\/app\/|\/_next\/static\/)/i;
const EMBED = /(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|loom\.com|wistia|vidyard|dailymotion|tiktok\.com|instagram\.com)/i;

// Resize/format parameters used by image CDNs (imgix, Cloudinary-style, Next, etc.)
const SIZE_PARAMS = ['w', 'h', 'width', 'height', 'fit', 'crop', 'q', 'quality', 'auto', 'fm', 'format', 'dpr', 'resize', 'size', 'max-w', 'max-h', 'maxwidth', 'maxheight', 'rect', 'blur', 'sharp', 'scale'];

function keyOf(u) {
  // Same file at different sizes counts once.
  try { const x = new URL(u); SIZE_PARAMS.forEach((p) => x.searchParams.delete(p)); x.hash = ''; return x.href; } catch (e) { return u; }
}

function variantsOf(u) {
  const out = [];
  try {
    const x = new URL(u);
    const before = x.href;
    SIZE_PARAMS.forEach((p) => x.searchParams.delete(p));
    if (x.href !== before) out.push(x.href);
    // Some CDNs put the size in the path (/w_800/, /800x600/, /resize/800/)
    const p2 = before.replace(/\/(w|h|c)_[^/]+\//g, '/').replace(/\/(\d{2,4})x(\d{2,4})\//, '/');
    if (p2 !== before && !out.includes(p2)) out.push(p2);
  } catch (e) { /* ignore */ }
  out.push(u);
  return out;
}

// ---------- Pitch specifics ----------
// Images: https://imgproxy.services.pitch.com/_/w:1336/.../format:avif/plain/pitch-assets-<bucket>/<uuid>
// "raw:1" makes imgproxy return the untouched original upload.
const IMGPROXY = 'https://imgproxy.services.pitch.com/_/';
function pitchSrc(u) {
  const m = /^https:\/\/(?:[a-z0-9-]+\.)?imgproxy\.services\.pitch\.com\/.*?\/plain\/(pitch-assets-[^?#]+)/i.exec(u);
  return m ? m[1] : null;
}
const pitchOriginal = (src) => `${IMGPROXY}raw:1/plain/${src}`;
const pitchThumb = (src) => `${IMGPROXY}w:360/h:360/resizing_type:fit/q:70/format:jpg/plain/${src}`;
// Videos: Mux HLS, https://stream.mux.com/<playbackId>.m3u8?token=… (thumbnails on image.mux.com)
const muxId = (u) => { const m = /^https:\/\/stream\.mux\.com\/([A-Za-z0-9]+)\.m3u8/.exec(u); return m ? m[1] : null; };
const muxThumbId = (u) => { const m = /^https:\/\/image\.mux\.com\/([A-Za-z0-9]+)\/thumbnail/.exec(u); return m ? m[1] : null; };
const isPitchDeck = (u) => /(^|\.)pitch\.com$/i.test((() => { try { return new URL(u).hostname; } catch (e) { return ''; } })());

// Width/height from the first bytes of a PNG, JPEG, GIF or WebP.
function dimsOf(b) {
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const f = b.toString('ascii', 12, 16);
      if (f === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (f === 'VP8L') { const n = b.readUInt32LE(21); return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff) }; }
      if (f === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch (e) { /* unknown */ }
  return null;
}

// Size, type and dimensions of an original without downloading all of it.
async function peek(url) { return retry(() => peekOnce(url)); }
async function peekOnce(url) {
  const ctl = new AbortController();
  const res = await session.fromPartition(PART()).fetch(url, { signal: ctl.signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const bytes = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  while (got < 262144) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); got += value.length; }
  try { ctl.abort(); } catch (e) { /* ignore */ }
  return { type, bytes, dims: dimsOf(Buffer.concat(chunks)) };
}

async function dataUrl(url) {
  try {
    const { buf } = await fetchBuf(url, 20 * 1024 * 1024);
    const img = nativeImage.createFromBuffer(buf);
    return img.isEmpty() ? null : 'data:image/jpeg;base64,' + img.resize({ width: 240, quality: 'good' }).toJPEG(72).toString('base64');
  } catch (e) { return null; }
}

// Best rendition in a Mux/HLS master playlist.
async function hlsInfo(url) {
  const res = await session.fromPartition(PART()).fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const r = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]); const bw = +((/[^-]BANDWIDTH=(\d+)/.exec(lines[i]) || [])[1] || 0);
    const w = r ? +r[1] : 0, h = r ? +r[2] : 0;
    let j = i + 1; while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
    const uri = lines[j] ? new URL(lines[j].trim(), url).href : null;
    if (uri && (!best || w * h > best.w * best.h || (w * h === best.w * best.h && bw > best.bw))) best = { w, h, bw, uri };
  }
  const separateAudio = /#EXT-X-MEDIA:.*TYPE=AUDIO/.test(text);
  return { master: url, best, separateAudio, isMaster: !!best };
}

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } }));
}

async function scan(rawOpts, emit, isCancelled) {
  cancelled = false;
  const opts = { maxPages: 200, settleMs: 1500, password: '', ...rawOpts };
  const url = String(opts.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Paste a full Pitch link starting with https://');
  const sess = pitchSession();
  const net = new Map(); // key -> {kind,url,type,size}
  const muxThumbs = new Map(); // playbackId -> thumbnail url
  const pitchDeck = isPitchDeck(url);
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  sess.webRequest.onCompleted(filter, (d) => {
    if (d.statusCode < 200 || d.statusCode >= 400) return;
    const h = d.responseHeaders || {};
    const get = (n) => { const k = Object.keys(h).find((x) => x.toLowerCase() === n); return k ? String(h[k][0] || '') : ''; };
    const ct = get('content-type').toLowerCase();
    const len = Number(get('content-length')) || 0;
    let kind = null;
    if (HLS.test(d.url) || /mpegurl/.test(ct)) kind = 'hls';
    else if (d.resourceType === 'media' || /^video\//.test(ct) || VIDEO_EXT.test(d.url)) kind = 'video';
    else if (d.resourceType === 'image' || /^image\//.test(ct) || (IMG_EXT.test(d.url) && d.resourceType !== 'stylesheet')) kind = 'image';
    if (!kind || SKIP.test(d.url)) return;
    const ps = pitchSrc(d.url), mid = muxId(d.url), mt = muxThumbId(d.url);
    if (mt) { muxThumbs.set(mt, d.url); return; }
    if (mid) { net.set('mux:' + mid, { kind: 'hls', url: d.url, type: ct, mux: mid }); return; }
    if (ps) { net.set('pimg:' + ps, { kind: 'image', url: d.url, type: ct, pitch: ps }); return; }
    if (pitchDeck) return; // on Pitch, everything else on the network is the app itself
    const k = kind === 'image' ? keyOf(d.url) : d.url.replace(/[?#].*$/, '');
    const prev = net.get(k);
    if (!prev || len > (prev.size || 0)) net.set(k, { kind, url: d.url, type: ct, size: len });
  });

  const emitThumb = (m) => emit({ kind: 'status', msg: m.msg, thumb: m.thumb });
  const win = await cap.createCaptureWindow(1920, 1080, PART(), { password: opts.password, _emit: emitThumb });
  const wc = win.webContents;
  const dom = new Map();
  let title = '';
  try {
    await cap.setMetrics(wc, 1920, 1080, 1);
    emit({ kind: 'status', msg: 'Opening the deck…' });
    await cap.load(win, url, opts.settleMs);
    const here = wc.getURL();
    if (/auth\.pitch\.com|\/login/i.test(here) || /continue with (email|google)/i.test(await wc.executeJavaScript('document.body.innerText').catch(() => ''))) {
      const e = new Error('This Pitch link needs you to be signed in. Click "Sign in to Pitch", sign in, then try again.');
      e.code = 'NEEDS_LOGIN';
      throw e;
    }
    title = wc.getTitle().replace(/\s*[|–-]\s*Pitch\s*$/i, '').trim() || 'Pitch deck';

    const collectDom = async () => {
      for (const f of wc.mainFrame.framesInSubtree) {
        let list = [];
        try { list = await f.executeJavaScript(SCAN_DOM); } catch (e) { continue; }
        for (const it of list) {
          if (SKIP.test(it.url)) continue;
          if (pitchDeck) {
            const ps = pitchSrc(it.url);
            if (ps) { if (!net.has('pimg:' + ps)) net.set('pimg:' + ps, { kind: 'image', url: it.url, pitch: ps }); continue; }
            if (it.kind !== 'embed') continue; // Pitch's own UI images and blob: players
          }
          if (it.kind === 'video' && /^blob:/.test(it.url)) continue; // streamed: the network side has it
          if (it.kind === 'embed' && !EMBED.test(it.url)) continue;
          const k = it.kind === 'image' ? keyOf(it.url) : it.url;
          const prev = dom.get(k);
          if (!prev || (it.w || 0) * (it.h || 0) > (prev.w || 0) * (prev.h || 0)) dom.set(k, it);
        }
      }
    };

    // Step through the slides. Editor links are only viewed, never edited: no keys are
    // sent there, slides are reached by clicking the slide list.
    const editor = /app\.pitch\.com\/app\/presentation\//.test(wc.getURL());
    let slides = 1;
    await collectDom();
    if (editor) {
      slides = await walkEditor(wc, opts, collectDom, emit, isCancelled);
    } else {
      let cur = await cap.settleShot(wc);
      const first = cur;
      for (;;) {
        emit({ kind: 'status', msg: `Slide ${slides}: ${dom.size + net.size} items so far…`, thumb: thumbOf(cur) });
        if (isCancelled() || slides >= opts.maxPages) break;
        const next = await cap.advance(wc, cur, opts.settleMs);
        if (!next) break;
        if (slides > 1 && cap.diff(first, next) < 1.5) break;
        cur = next; slides++;
        await sleep(800);
        await collectDom();
      }
    }
    await sleep(1500); // let the last requests finish
    await collectDom();
    emit({ kind: 'status', msg: `Checked ${slides} slide${slides === 1 ? '' : 's'}. Finding the full-size versions…` });
  } finally {
    sess.webRequest.onCompleted(null);
    win.destroy();
  }
  if (isCancelled()) throw new Error('Cancelled.');
  if (pitchDeck) return { title, items: await resolvePitch(net, muxThumbs, dom, emit, isCancelled) };
  return { title, items: await resolveItems(net, dom, emit, isCancelled) };
}

// Editor view: click each slide in the slide list (read-only), waiting for it to load.
async function walkEditor(wc, opts, collectDom, emit, isCancelled) {
  // Pitch's slide list: one [data-test-id="editor-sidebar-slides-item"] per slide.
  const LIST = `(()=>{window.__bdSlides=[...document.querySelectorAll('[data-test-id="editor-sidebar-slides-item"]')];return window.__bdSlides.length})()`;
  let n = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { // the editor takes a while to build
    try { n = await wc.executeJavaScript(LIST); } catch (e) { n = 0; }
    if (n) break;
    await sleep(1000);
  }
  if (!n) return 1;
  for (let i = 0; i < Math.min(n, opts.maxPages); i++) {
    if (isCancelled()) break;
    await wc.executeJavaScript(`(()=>{const e=window.__bdSlides[${i}];if(!e)return false;e.scrollIntoView({block:'center'});e.click();return true})()`).catch(() => false);
    await sleep(Math.max(2500, opts.settleMs)); // videos start loading only once their slide is open
    await collectDom();
    emit({ kind: 'status', msg: `Slide ${i + 1} of ${n}…`, thumb: thumbOf(await cap.settleShot(wc)) });
  }
  return n;
}

function thumbOf(buf) {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    return 'data:image/jpeg;base64,' + img.resize({ width: 360, quality: 'good' }).toJPEG(70).toString('base64');
  } catch (e) { return null; }
}

async function fetchBuf(url, max) { return retry(() => fetchBufOnce(url, max)); }
async function fetchBufOnce(url, max = 200 * 1024 * 1024) {
  const res = await session.fromPartition(PART()).fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error('too big');
  return { buf, type: (res.headers.get('content-type') || '').toLowerCase() };
}

async function resolvePitch(net, muxThumbs, dom, emit, isCancelled) {
  const imgs = [...net.values()].filter((x) => x.pitch);
  const vids = [...net.values()].filter((x) => x.mux);
  const items = [];
  let done = 0;
  await pool(imgs, 6, async (it) => {
    if (isCancelled()) return;
    const url = pitchOriginal(it.pitch);
    try {
      const p = await peek(url);
      if (!/^image\//.test(p.type)) return;
      // Skip bullet icons and tiny decorations (originals under 100 px, or a couple of KB)
      if ((p.dims && Math.max(p.dims.w, p.dims.h) < 100) || (p.bytes && p.bytes < 2048 && !/svg/.test(p.type))) return;
      items.push({ kind: 'image', url, type: p.type, bytes: p.bytes, w: p.dims ? p.dims.w : 0, h: p.dims ? p.dims.h : 0, thumb: await dataUrl(pitchThumb(it.pitch)), key: it.pitch });
    } catch (e) { emit({ kind: 'log', msg: 'Skipped an image that would not load: ' + e.message }); }
    emit({ kind: 'status', msg: `Checking originals… ${++done} of ${imgs.length + vids.length}`, pct: (done / (imgs.length + vids.length)) * 100 });
  });
  for (const v of vids) {
    if (isCancelled()) break;
    try {
      const h = await hlsInfo(v.url);
      items.push({ kind: 'hls', url: v.url, w: h.best ? h.best.w : 0, h: h.best ? h.best.h : 0, bytes: 0, mux: v.mux, thumb: muxThumbs.has(v.mux) ? await dataUrl(muxThumbs.get(v.mux)) : null, key: v.mux });
    } catch (e) { emit({ kind: 'log', msg: 'Skipped a video that would not load: ' + e.message }); }
    emit({ kind: 'status', msg: `Checking originals… ${++done} of ${imgs.length + vids.length}`, pct: (done / (imgs.length + vids.length)) * 100 });
  }
  if (isCancelled()) throw new Error('Cancelled.');
  for (const e of dom.values()) if (e.kind === 'embed' && !items.some((x) => x.url === e.url)) items.push({ kind: 'embed', url: e.url });
  // Keep the deck's own order as best we can: the order they were first seen.
  const order = [...net.keys()];
  items.sort((a, b) => order.indexOf((a.mux ? 'mux:' : 'pimg:') + a.key) - order.indexOf((b.mux ? 'mux:' : 'pimg:') + b.key));
  items.forEach((x, n) => { x.id = n + 1; });
  return items;
}

// Merge network + page findings, fetch the best version of each image, drop UI bits.
async function resolveItems(net, dom, emit, isCancelled) {
  const merged = new Map();
  for (const [k, v] of dom) merged.set(k, { ...v });
  for (const [k, v] of net) {
    const m = merged.get(k);
    if (m) { m.netUrl = v.url; m.type = v.type; } else merged.set(k, { kind: v.kind, url: v.url, type: v.type, size: v.size });
  }
  // HLS: keep master playlists only (variant playlists listed inside are skipped).
  const items = [];
  let i = 0;
  const all = [...merged.values()];
  for (const it of all) {
    if (isCancelled()) throw new Error('Cancelled.');
    i++;
    if (it.kind === 'image') {
      emit({ kind: 'status', msg: `Checking image ${i} of ${all.length}…` });
      let best = null;
      for (const v of variantsOf(it.url)) {
        try {
          const r = await fetchBuf(v, 80 * 1024 * 1024);
          if (!/^image\//.test(r.type) && !IMG_EXT.test(v)) continue;
          if (!best || r.buf.length > best.buf.length) best = { ...r, url: v };
        } catch (e) { /* try next */ }
      }
      if (!best) continue;
      const img = nativeImage.createFromBuffer(best.buf);
      const sz = img.isEmpty() ? { width: it.w || 0, height: it.h || 0 } : img.getSize();
      const svg = /svg/.test(best.type);
      // Skip icons and tiny UI pieces
      if (!svg && sz.width && sz.height && (sz.width < 120 || sz.height < 120)) continue;
      if (best.buf.length < 6000 && !svg) continue;
      if (svg && best.buf.length < 3000) continue;
      items.push({
        kind: 'image', url: best.url, type: best.type, bytes: best.buf.length, w: sz.width, h: sz.height,
        thumb: img.isEmpty() ? null : 'data:image/jpeg;base64,' + img.resize({ width: 240, quality: 'good' }).toJPEG(70).toString('base64'),
      });
    } else if (it.kind === 'video' || it.kind === 'hls') {
      items.push({ kind: it.kind, url: it.url, type: it.type, bytes: it.size || 0, w: it.w || 0, h: it.h || 0, poster: it.poster || null });
    } else if (it.kind === 'embed') {
      items.push({ kind: 'embed', url: it.url });
    }
  }
  // HLS variant playlists (…/720p.m3u8) next to a master: keep the master
  const hls = items.filter((x) => x.kind === 'hls');
  const masters = hls.filter((x) => !/\/(\d{3,4}p|v\d|stream_\d)[^/]*\.m3u8/i.test(x.url));
  const keep = new Set(masters.length ? masters : hls);
  const out = items.filter((x) => x.kind !== 'hls' || keep.has(x));
  // Video posters: attach as the video's thumbnail
  for (const v of out.filter((x) => x.kind !== 'image' && x.poster)) {
    const p = out.find((x) => x.kind === 'image' && keyOf(x.url) === keyOf(v.poster));
    if (p) v.thumb = p.thumb;
  }
  out.forEach((x, n) => { x.id = n + 1; });
  return out;
}

// ---------- downloading ----------
function safe(s) { return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Pitch deck'; }
function extFor(it) {
  const t = it.type || '';
  const m = /image\/(jpeg|png|gif|webp|avif|svg\+xml|heic|tiff|bmp)/.exec(t);
  if (m) return { jpeg: 'jpg', 'svg+xml': 'svg' }[m[1]] || m[1];
  const v = /video\/(mp4|quicktime|webm|x-matroska|x-m4v)/.exec(t);
  if (v) return { quicktime: 'mov', 'x-matroska': 'mkv', 'x-m4v': 'm4v' }[v[1]] || v[1];
  const e = /\.([a-z0-9]{2,4})(\?|$)/i.exec(it.url.replace(/[?#].*$/, ''));
  if (e) return e[1].toLowerCase();
  return it.kind === 'image' ? 'jpg' : 'mp4';
}
function baseName(it) {
  if (it.mux) return 'video_' + it.mux.slice(0, 10);
  if (it.key && /^pitch-assets-/.test(it.key)) return it.key.split('/').pop().slice(0, 8);
  try { return decodeURIComponent(path.basename(new URL(it.url).pathname)).replace(/\.[^.]+$/, '').slice(0, 60); } catch (e) { return ''; }
}

async function streamTo(url, dest, onProgress) { return retry(() => streamToOnce(url, dest, onProgress)); }
async function streamToOnce(url, dest, onProgress) {
  const res = await session.fromPartition(PART()).fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => { got += c.length; if (onProgress) onProgress(got, total); });
  try { await pipeline(src, fs.createWriteStream(dest)); } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
}

async function hlsDuration(url) {
  try {
    const t = await (await session.fromPartition(PART()).fetch(url)).text();
    return t.split('\n').reduce((s, l) => { const m = /^#EXTINF:([\d.]+)/.exec(l); return s + (m ? +m[1] : 0); }, 0);
  } catch (e) { return 0; }
}

async function ffmpegHls(ff, url, dest, onProgress) {
  // Pick the highest-resolution rendition ourselves (Mux doesn't list it first). If audio
  // is a separate track, hand ffmpeg the master playlist so it muxes both.
  let input = url, total = 0;
  try {
    const h = await hlsInfo(url);
    if (h.best && !h.separateAudio) input = h.best.uri;
    total = await hlsDuration(h.best ? h.best.uri : url);
  } catch (e) { /* let ffmpeg read the master */ }
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-y',
      '-user_agent', pitchSession().getUserAgent(), '-i', input, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', dest];
    child = spawn(ff, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.on('data', (d) => { const m = /out_time_us=(\d+)/.exec(String(d)); if (m && onProgress) onProgress(+m[1] / 1e6, total); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => { child = null; if (cancelled) { fs.rmSync(dest, { force: true }); return reject(new Error('Cancelled.')); } if (code === 0) resolve(); else { fs.rmSync(dest, { force: true }); reject(new Error('Could not save the stream: ' + (err.split('\n').filter(Boolean).slice(-1)[0] || 'ffmpeg failed'))); } });
  });
}

async function download(rawOpts, emit) {
  cancelled = false;
  const opts = { items: [], outDir: '', title: 'Pitch deck', ...rawOpts };
  if (!opts.outDir) throw new Error('Choose a folder to save to.');
  const items = opts.items.filter((x) => x && x.kind !== 'embed' && /^https?:\/\//.test(x.url || ''));
  if (!items.length) throw new Error('Select at least one image or video.');
  let dir = path.join(opts.outDir, safe(opts.title));
  const stem = dir;
  for (let k = 2; fs.existsSync(dir) && fs.readdirSync(dir).length; k++) dir = `${stem} ${k}`;
  const saved = [], failed = [];
  let ff = null;
  for (let i = 0; i < items.length; i++) {
    if (cancelled) break;
    const it = items[i];
    const sub = it.kind === 'image' ? 'images' : 'videos';
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    const nm = baseName(it);
    const ext = it.kind === 'hls' ? 'mp4' : extFor(it);
    const dest = path.join(dir, sub, `${String(i + 1).padStart(3, '0')}${nm ? '_' + safe(nm).replace(/ /g, '_') : ''}.${ext}`);
    const step = (pct, msg) => emit({ kind: 'progress', index: i + 1, count: items.length, pct: ((i + Math.min(1, pct)) / items.length) * 100, msg });
    step(0, `Saving ${i + 1} of ${items.length}…`);
    try {
      if (it.kind === 'hls') {
        if (!ff) ff = await yt.ensureFfmpeg((m) => emit({ ...m, kind: 'status' }));
        await ffmpegHls(ff, it.url, dest, (sec, total) => step(total ? sec / total : 0.5, `Saving video ${i + 1} of ${items.length}: ${Math.round(sec)}s${total ? ' of ' + Math.round(total) + 's' : ''}`));
      } else {
        await streamTo(it.url, dest, (got, total) => step(total ? got / total : 0, `Saving ${i + 1} of ${items.length}: ${(got / 1048576).toFixed(1)} MB`));
      }
      saved.push(dest);
    } catch (e) {
      if (cancelled) break;
      failed.push({ url: it.url, error: e.message });
      emit({ kind: 'log', msg: `Could not save ${it.url.slice(0, 100)}: ${e.message}` });
    }
  }
  if (cancelled) throw new Error('Cancelled.');
  if (!saved.length) throw new Error('Nothing could be saved. ' + (failed[0] ? failed[0].error : ''));
  return { dir, files: saved, failed };
}

function cancel() { cancelled = true; if (child) { try { child.kill('SIGTERM'); } catch (e) { /* ignore */ } } }

module.exports = { scan, download, cancel, signIn, signOut, isSignedIn, variantsOf, keyOf };
