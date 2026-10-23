'use strict';
// Video Downloader tab
(() => {
  const $ = (id) => document.getElementById(id);
  let lastDir = null;
  let busy = false;

  const log = (msg) => {
    const el = $('ytLog');
    el.textContent += (el.textContent ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
  };

  const fmtSpeed = (b) => (b ? (b / 1048576).toFixed(1) + ' MB/s' : '');
  const fmtEta = (s) => (s ? (s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's') + ' left' : '');

  async function refreshStatus() {
    const st = await window.bd.ytStatus();
    $('ytVersion').textContent = st.ytdlp ? 'yt-dlp ' + st.ytdlp : 'yt-dlp is not installed yet (it downloads automatically on first use)';
    $('ytFfmpeg').textContent = st.ffmpeg ? 'ffmpeg ready' : 'ffmpeg downloads automatically on first use';
    $('ytUpdate').textContent = st.ytdlp ? 'Update yt-dlp' : 'Install yt-dlp';
    $('ytFfInstall').hidden = st.ffmpeg;
  }

  window.__bdVideoShown = () => { refreshStatus(); };
  window.bd.defaultVideoDir().then((d) => { $('ytOutDir').value = d; });
  $('ytPick').onclick = async () => { const d = await window.bd.pickFolder(); if (d) $('ytOutDir').value = d; };
  $('ytReveal').onclick = () => { if (lastDir) window.bd.reveal(lastDir); };
  $('ytStop').onclick = () => { window.bd.ytCancel(); log('Cancelling…'); };

  function setBusy(b) {
    busy = b;
    $('ytGo').disabled = b;
    $('ytUpdate').disabled = b;
    $('ytStop').hidden = !b;
  }

  function setup(m) {
    $('ytSetup').hidden = false;
    if (m.msg) { $('ytSetupText').textContent = m.msg; log(m.msg); }
    if (typeof m.pct === 'number') { $('ytSetupPct').textContent = m.pct + '%'; $('ytSetupFill').style.width = m.pct + '%'; }
  }

  window.bd.onYtProgress((m) => {
    if (m.kind === 'setup') setup(m);
    else if (m.kind === 'item') {
      $('ytBox').hidden = false;
      $('ytItem').textContent = m.count > 1 ? `Video ${m.index} of ${m.count}` : 'Downloading';
      $('ytFill').style.width = '0%'; $('ytPct').textContent = '';
      $('ytTitle').textContent = m.url; $('ytSub').textContent = ''; $('ytSpeed').textContent = '';
      $('ytThumb').style.display = 'none'; $('ytThumbEmpty').style.display = '';
    } else if (m.kind === 'info') {
      if (m.title) $('ytTitle').textContent = m.title;
      $('ytSub').textContent = [m.uploader, m.duration].filter((x) => x && x !== 'NA').join(' · ');
      if (m.thumbnail) { $('ytThumb').src = m.thumbnail; $('ytThumb').style.display = 'block'; $('ytThumbEmpty').style.display = 'none'; }
    } else if (m.kind === 'progress') {
      $('ytFill').style.width = m.pct.toFixed(1) + '%';
      $('ytPct').textContent = m.pct.toFixed(0) + '%';
      $('ytSpeed').textContent = [fmtSpeed(m.speed), fmtEta(m.eta)].filter(Boolean).join(' · ');
    } else if (m.kind === 'itemFailed') {
      $('ytItem').textContent = `Video ${m.index} of ${m.count} failed`;
      $('ytSub').textContent = m.error; $('ytSpeed').textContent = '';
      $('ytFill').style.width = '0%'; $('ytPct').textContent = '';
    } else if (m.kind === 'itemDone') {
      $('ytFill').style.width = '100%'; $('ytPct').textContent = '100%';
    } else if (m.kind === 'log') {
      log(m.msg);
    }
  });

  $('ytFfInstall').onclick = async () => {
    $('ytLog').textContent = '';
    setBusy(true); $('ytFfInstall').disabled = true;
    const res = await window.bd.ffInstall();
    setBusy(false); $('ytFfInstall').disabled = false;
    if (!res.ok) log('Error: ' + res.error);
    $('ytSetup').hidden = true;
    await refreshStatus();
  };
  window.__bdRefreshYt = refreshStatus;

  $('ytUpdate').onclick = async () => {
    $('ytLog').textContent = '';
    setBusy(true);
    const res = await window.bd.ytUpdate();
    setBusy(false);
    if (!res.ok) { log('Error: ' + res.error); $('ytSetupText').textContent = res.error; }
    await refreshStatus();
  };

  $('ytGo').onclick = async () => {
    $('ytLog').textContent = '';
    const urls = $('ytUrls').value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!urls.length) { log('Paste at least one video link first.'); return; }
    setBusy(true);
    $('ytReveal').hidden = true;
    const res = await window.bd.ytDownload({
      urls,
      quality: $('ytQuality').value,
      cookies: $('ytCookies').value,
      playlist: $('ytPlaylist').checked,
      outDir: $('ytOutDir').value,
    });
    setBusy(false);
    $('ytSetup').hidden = true;
    if (res.ok) {
      lastDir = res.files && res.files[0] ? res.files[0] : res.dir;
      const nf = res.failed ? res.failed.length : 0;
      $('ytItem').textContent = nf ? `Done: ${res.files.length} saved, ${nf} failed` : 'Done';
      if (!nf) { $('ytFill').style.width = '100%'; $('ytPct').textContent = '100%'; }
      log(`Done. Saved ${res.files.length} file${res.files.length === 1 ? '' : 's'} to:\n${res.dir}`);
      if (res.failed && res.failed.length) log(`${res.failed.length} link${res.failed.length === 1 ? '' : 's'} failed:\n` + res.failed.map((f) => `• ${f.url}\n  ${f.error.split('\n')[0]}`).join('\n'));
      $('ytReveal').hidden = false;
    } else {
      $('ytItem').textContent = res.error.split('\n')[0];
      log('Error: ' + res.error);
    }
    refreshStatus();
  };

  refreshStatus();
})();
