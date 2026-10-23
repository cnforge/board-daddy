'use strict';
// Frames & Scenes tab
(() => {
  const $ = (id) => document.getElementById(id);
  let lastDir = null;

  const log = (msg) => {
    const el = $('frLog');
    el.textContent += (el.textContent ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
  };

  async function refreshFf() {
    const st = await window.bd.ytStatus();
    if (st.ffmpeg) {
      $('frFfStatus').textContent = 'ffmpeg ready';
      $('frFfSub').textContent = st.ffmpegBundled ? 'Using the copy Board Daddy installed' : 'Using ' + st.ffmpegPath;
    } else {
      $('frFfStatus').textContent = 'ffmpeg is not installed';
      $('frFfSub').textContent = 'Needed for frame extraction and scene detection (one-time download, about 30 MB).';
    }
    $('frFfInstall').hidden = st.ffmpeg;
  }
  window.__bdFramesShown = refreshFf;
  refreshFf();
  $('frFfInstall').onclick = async () => {
    $('frLog').textContent = '';
    $('frFfInstall').disabled = true; $('frGo').disabled = true;
    const res = await window.bd.ffInstall();
    $('frFfInstall').disabled = false; $('frGo').disabled = false;
    if (res.ok) { log('ffmpeg is ready.'); $('frBox').hidden = true; } else log('Error: ' + res.error);
    await refreshFf();
  };

  window.bd.defaultFramesDir().then((d) => { $('frOutDir').value = d; });
  $('frPickFile').onclick = async () => { const f = await window.bd.pickVideo(); if (f) $('frFile').value = f; };
  $('frPickOut').onclick = async () => { const d = await window.bd.pickFolder(); if (d) $('frOutDir').value = d; };
  $('frReveal').onclick = () => { if (lastDir) window.bd.reveal(lastDir); };
  $('frStop').onclick = () => { window.bd.framesCancel(); log('Cancelling…'); };

  function syncMode() {
    const m = $('frMode').value;
    const scenes = m === 'scenes';
    $('frPickWrap').hidden = !scenes;
    $('frSensWrap').hidden = !scenes;
    $('frMinWrap').hidden = !scenes;
    $('frEveryWrap').hidden = scenes;
    $('frEveryLabel').textContent = m === 'frames' ? 'Every (frames)' : 'Every (seconds)';
    $('frEvery').value = m === 'frames' ? 24 : 1;
  }
  $('frMode').onchange = syncMode;
  $('frThreshold').oninput = () => { $('frSensVal').textContent = Number($('frThreshold').value).toFixed(2) + ' · lower finds more cuts'; };
  syncMode();

  function setBusy(b) {
    $('frGo').disabled = b;
    $('frStop').hidden = !b;
  }

  window.bd.onFramesProgress((m) => {
    if (m.kind === 'setup') {
      $('frBox').hidden = false;
      if (m.msg) { $('frItem').textContent = m.msg; log(m.msg); }
      if (typeof m.pct === 'number') { $('frPct').textContent = m.pct + '%'; $('frFill').style.width = m.pct + '%'; }
    } else if (m.kind === 'info') {
      log('Video: ' + m.msg);
    } else if (m.kind === 'log') {
      log(m.msg);
    } else if (m.kind === 'progress') {
      $('frBox').hidden = false;
      $('frFill').style.width = m.pct.toFixed(1) + '%';
      $('frPct').textContent = m.pct.toFixed(0) + '%';
      $('frItem').textContent = m.msg;
      if (m.thumb) {
        const fig = document.createElement('figure');
        const img = document.createElement('img'); img.src = m.thumb; img.alt = 'Frame ' + m.index;
        const cap = document.createElement('figcaption'); cap.textContent = m.at || '';
        fig.append(img, cap);
        const strip = $('frStrip');
        strip.append(fig);
        if (strip.children.length > 40) strip.firstChild.remove();
        strip.scrollLeft = strip.scrollWidth;
      }
    }
  });

  $('frGo').onclick = async () => {
    $('frLog').textContent = '';
    $('frStrip').textContent = '';
    $('frReveal').hidden = true;
    if (!$('frFile').value) { log('Choose a video file first.'); return; }
    setBusy(true);
    $('frBox').hidden = false; $('frFill').style.width = '0%'; $('frPct').textContent = ''; $('frItem').textContent = 'Starting…';
    const res = await window.bd.framesStart({
      file: $('frFile').value,
      outDir: $('frOutDir').value,
      mode: $('frMode').value,
      pick: $('frPick').value,
      threshold: Number($('frThreshold').value),
      minShot: Number($('frMin').value),
      every: Number($('frEvery').value),
      format: $('frFormat').value,
      csv: $('frCsv').checked,
    });
    setBusy(false);
    if (res.ok) {
      lastDir = res.files[0] || res.dir;
      refreshFf();
      $('frItem').textContent = `Done: ${res.count} frame${res.count === 1 ? '' : 's'}`;
      $('frFill').style.width = '100%'; $('frPct').textContent = '100%';
      log(`Done. Saved ${res.count} frames${res.csv ? ' and a shot list' : ''} to:\n${res.dir}`);
      $('frReveal').hidden = false;
    } else {
      $('frItem').textContent = res.error.split('\n')[0];
      log('Error: ' + res.error);
    }
  };
})();
