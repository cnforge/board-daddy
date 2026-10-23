'use strict';
const $ = (id) => document.getElementById(id);
let lastDir = null;
let running = false; // progress messages can arrive after the job has finished; ignore those

// Dark mode switch: remembers your choice, otherwise follows the system setting.
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('darkMode').checked = dark;
}
let saved = null;
try { saved = localStorage.getItem('bd-theme'); } catch (e) { /* ignore */ }
applyTheme(saved ? saved === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches);
$('darkMode').onchange = (e) => {
  applyTheme(e.target.checked);
  try { localStorage.setItem('bd-theme', e.target.checked ? 'dark' : 'light'); } catch (err) { /* ignore */ }
};

function log(msg) {
  const el = $('log');
  el.textContent += (el.textContent ? '\n' : '') + msg;
  el.scrollTop = el.scrollHeight;
}

function setBusy(busy) {
  running = busy;
  $('go').disabled = busy;
  $('stop').hidden = !busy;
  if (busy) {
    $('reveal').hidden = true;
    $('progressBox').hidden = false;
    $('strip').textContent = '';
    $('thumb').style.display = 'none';
    $('screenEmpty').style.display = '';
    $('statusText').textContent = 'Starting…';
    $('statusPct').textContent = '';
    $('fill').classList.add('indet');
    $('fill').style.width = '';
  }
}

$('showPw').onchange = (e) => { $('password').type = e.target.checked ? 'text' : 'password'; };

window.bd.defaultDir().then((d) => { $('outDir').value = d; });
$('pick').onclick = async () => { const d = await window.bd.pickFolder(); if (d) $('outDir').value = d; };
$('stop').onclick = () => { window.bd.cancel(); log('Cancelling…'); };
$('reveal').onclick = () => { if (lastDir) window.bd.reveal(lastDir); };

window.bd.onProgress((m) => {
  if (!running) return;
  const fill = $('fill');
  if (m.total > 0) {
    fill.classList.remove('indet');
    fill.style.width = Math.round((m.current / m.total) * 100) + '%';
    $('statusPct').textContent = `${m.current} / ${m.total}  ·  ${Math.round((m.current / m.total) * 100)}%`;
  } else if (m.current > 0) {
    fill.classList.add('indet'); fill.style.width = '';
    $('statusPct').textContent = `${m.current} pages`;
  }
  if (m.msg) { $('statusText').textContent = m.msg; log(m.msg); }
  if (m.thumb) {
    const t = $('thumb');
    t.src = m.thumb; t.style.display = 'block';
    $('screenEmpty').style.display = 'none';
    if (m.phase === 'capture') {
      const img = document.createElement('img');
      img.src = m.thumb; img.alt = 'Page ' + m.current;
      const strip = $('strip');
      strip.appendChild(img);
      strip.scrollLeft = strip.scrollWidth;
    }
  }
});

$('go').onclick = async () => {
  $('log').textContent = '';
  const opts = {
    url: $('url').value.trim(),
    password: $('password').value,
    mode: $('mode').value,
    scale: Number($('scale').value),
    width: Number($('width').value) || 1920,
    height: Number($('height').value) || 1080,
    maxPages: Number($('maxPages').value) || 300,
    settleMs: Math.round((Number($('settle').value) || 2.5) * 1000),
    autoSize: $('autoSize').checked,
    outDir: $('outDir').value,
    formats: { pdf: $('fPdf').checked, png: $('fPng').checked, text: $('fText').checked },
  };
  if (!opts.url) { log('Paste a link first.'); return; }
  setBusy(true);
  const res = await window.bd.start(opts);
  setBusy(false);
  if (res.ok) {
    $('fill').classList.remove('indet'); $('fill').style.width = '100%';
    $('statusText').textContent = 'Done';
    $('statusPct').textContent = `${res.pageCount} pages · 100%`;
    lastDir = res.dir;
    log(`Done. ${res.pageCount} pages saved to:\n${res.dir}`);
    $('reveal').hidden = false;
  } else {
    $('fill').classList.remove('indet');
    $('statusText').textContent = res.error;
    log('Error: ' + res.error);
  }
};

// Tabs
document.querySelectorAll('.tab').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b)); });
    $('tab-export').hidden = b.dataset.tab !== 'export';
    $('tab-video').hidden = b.dataset.tab !== 'video';
    $('tab-frames').hidden = b.dataset.tab !== 'frames';
    $('tab-pitch').hidden = b.dataset.tab !== 'pitch';
    if (b.dataset.tab === 'pitch' && window.__bdPitchShown) window.__bdPitchShown();
    if (b.dataset.tab === 'video' && window.__bdVideoShown) window.__bdVideoShown();
    if (b.dataset.tab === 'frames' && window.__bdFramesShown) window.__bdFramesShown();
  };
});
