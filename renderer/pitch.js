'use strict';
// Pitch Media tab
(() => {
  const $ = (id) => document.getElementById(id);
  let found = null; // { title, items }
  let lastDir = null;
  let busy = false;

  const log = (msg) => { const el = $('pLog'); el.textContent += (el.textContent ? '\n' : '') + msg; el.scrollTop = el.scrollHeight; };
  const mb = (b) => (b ? (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB') : '');

  async function refreshAccount() {
    const st = await window.bd.pitchStatus();
    $('pAccount').textContent = st.signedIn ? 'Signed in to Pitch' : 'Not signed in to Pitch';
    $('pSignIn').textContent = st.signedIn ? 'Sign in again' : 'Sign in to Pitch';
    $('pSignOut').hidden = !st.signedIn;
  }
  window.__bdPitchShown = refreshAccount;
  window.bd.defaultPitchDir().then((d) => { $('pOutDir').value = d; });
  $('pPick').onclick = async () => { const d = await window.bd.pickFolder(); if (d) $('pOutDir').value = d; };
  $('pReveal').onclick = () => { if (lastDir) window.bd.reveal(lastDir); };
  $('pStop').onclick = () => { window.bd.pitchCancel(); log('Cancelling…'); };
  $('pSignIn').onclick = async () => {
    log('A Pitch window opened. Sign in there; it closes by itself when you are in (or close it when done).');
    await window.bd.pitchSignIn($('pUrl').value.trim());
    await refreshAccount();
    log($('pAccount').textContent + '.');
  };
  $('pSignOut').onclick = async () => { await window.bd.pitchSignOut(); await refreshAccount(); log('Signed out of Pitch.'); };

  function setBusy(b) {
    busy = b;
    $('pScan').disabled = b; $('pGo').disabled = b; $('pSignIn').disabled = b;
    $('pStop').hidden = !b;
  }

  window.bd.onPitchProgress((m) => {
    if (!busy) return;
    $('pBox').hidden = false;
    if (m.kind === 'log') { log(m.msg); return; }
    if (m.msg) $('pStatus').textContent = m.msg;
    if (typeof m.pct === 'number') { $('pFill').style.width = m.pct.toFixed(1) + '%'; $('pPct').textContent = Math.round(m.pct) + '%'; }
    if (m.thumb) { $('pPeek').src = m.thumb; $('pPeek').hidden = false; }
  });

  function card(it) {
    const c = document.createElement('div');
    c.className = 'pcard sel';
    c.dataset.kind = it.kind === 'image' ? 'image' : 'video';
    const box = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.id = it.id;
    cb.onchange = () => { c.classList.toggle('sel', cb.checked); summary(); };
    const pic = document.createElement('div'); pic.className = 'pimg';
    if (it.thumb) { const im = document.createElement('img'); im.src = it.thumb; im.alt = ''; pic.append(im); } else pic.textContent = it.kind === 'image' ? 'Image' : 'Video';
    const meta = document.createElement('div'); meta.className = 'pmeta';
    const a = document.createElement('span'); a.textContent = it.w && it.h ? `${it.w}×${it.h}` : (it.kind === 'hls' ? 'stream' : '');
    const b = document.createElement('span'); b.textContent = mb(it.bytes);
    meta.append(a, b);
    box.append(cb, pic, meta);
    c.append(box);
    if (it.kind !== 'image') { const t = document.createElement('span'); t.className = 'badge'; t.textContent = 'video'; c.append(t); }
    return c;
  }

  function summary() {
    const boxes = [...document.querySelectorAll('#pGrid .pcard')].filter((c) => !c.hidden);
    const sel = boxes.filter((c) => c.querySelector('input').checked).length;
    const imgs = found.items.filter((x) => x.kind === 'image').length;
    const vids = found.items.filter((x) => x.kind === 'video' || x.kind === 'hls').length;
    $('pSummary').textContent = `${imgs} image${imgs === 1 ? '' : 's'}, ${vids} video${vids === 1 ? '' : 's'} · ${sel} selected`;
    $('pGo').disabled = busy || !sel;
  }
  const filter = () => {
    document.querySelectorAll('#pGrid .pcard').forEach((c) => { c.hidden = c.dataset.kind === 'image' ? !$('pShowImg').checked : !$('pShowVid').checked; });
    summary();
  };
  $('pShowImg').onchange = filter; $('pShowVid').onchange = filter;
  const selectAll = (v) => { document.querySelectorAll('#pGrid .pcard').forEach((c) => { if (c.hidden) return; const cb = c.querySelector('input'); cb.checked = v; c.classList.toggle('sel', v); }); summary(); };
  $('pAll').onclick = () => selectAll(true);
  $('pNone').onclick = () => selectAll(false);

  function show(res) {
    found = res;
    const grid = $('pGrid'); grid.textContent = '';
    res.items.filter((x) => x.kind !== 'embed').forEach((it) => grid.append(card(it)));
    const embeds = res.items.filter((x) => x.kind === 'embed');
    const eb = $('pEmbeds'); eb.textContent = ''; eb.hidden = !embeds.length;
    if (embeds.length) {
      const h = document.createElement('div'); h.textContent = 'Embedded videos (YouTube, Vimeo, Loom…) download through the Video Downloader tab:'; eb.append(h);
      embeds.forEach((e) => {
        const r = document.createElement('div'); r.className = 'erow';
        const s = document.createElement('span'); s.textContent = e.url;
        const b = document.createElement('button'); b.className = 'ghost'; b.textContent = 'Send to Video Downloader';
        b.onclick = () => {
          const ta = $('ytUrls');
          ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + e.url;
          $('tabBtnVideo').click();
        };
        r.append(s, b); eb.append(r);
      });
    }
    $('pResults').hidden = false;
    filter();
  }

  $('pScan').onclick = async () => {
    $('pLog').textContent = '';
    const url = $('pUrl').value.trim();
    if (!url) { log('Paste a Pitch link first.'); return; }
    $('pResults').hidden = true; $('pReveal').hidden = true; $('pPeek').hidden = true;
    $('pFill').style.width = '0%'; $('pPct').textContent = ''; $('pStatus').textContent = 'Starting…';
    setBusy(true);
    const res = await window.bd.pitchScan({ url, password: $('pPassword').value });
    setBusy(false);
    if (res.ok) {
      $('pStatus').textContent = 'Done looking';
      $('pFill').style.width = '100%';
      const n = res.items.length;
      log(n ? `Found ${n} item${n === 1 ? '' : 's'} in "${res.title}". Untick anything you don't want, then Download selected.` : 'No images or videos were found in this deck.');
      if (n) show(res);
    } else {
      $('pStatus').textContent = res.error.split('\n')[0];
      log('Error: ' + res.error);
      if (res.code === 'NEEDS_LOGIN') { $('pSignIn').focus(); refreshAccount(); }
    }
  };

  $('pGo').onclick = async () => {
    if (!found) return;
    const ids = new Set([...document.querySelectorAll('#pGrid .pcard')].filter((c) => !c.hidden && c.querySelector('input').checked).map((c) => Number(c.querySelector('input').dataset.id)));
    const items = found.items.filter((x) => ids.has(x.id)).map(({ thumb, ...rest }) => rest);
    if (!items.length) return;
    $('pFill').style.width = '0%'; $('pPct').textContent = ''; $('pReveal').hidden = true; $('pPeek').hidden = true;
    setBusy(true);
    const res = await window.bd.pitchDownload({ items, outDir: $('pOutDir').value, title: found.title });
    setBusy(false);
    summary();
    if (res.ok) {
      lastDir = res.files[0] || res.dir;
      $('pFill').style.width = '100%'; $('pPct').textContent = '100%';
      $('pStatus').textContent = res.failed.length ? `Done: ${res.files.length} saved, ${res.failed.length} failed` : 'Done';
      log(`Saved ${res.files.length} file${res.files.length === 1 ? '' : 's'} to:\n${res.dir}`);
      $('pReveal').hidden = false;
    } else {
      $('pStatus').textContent = res.error.split('\n')[0];
      log('Error: ' + res.error);
    }
  };

  refreshAccount();
})();
