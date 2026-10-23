'use strict';
// End-to-end: boots the real app (main.js + preload + renderer) and clicks through every tab.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-e2e-'));
process.env.BD_BIN_DIR = path.join(tmp, 'bin');
process.env.BD_IGNORE_SYSTEM_FFMPEG = '1';
process.env.BD_PITCH_PARTITION = 'pitche2e';
const { app, BrowserWindow } = require('electron');
require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };

// fixtures
const slides = [1, 2, 3].map((n) => `<div class="s" style="display:${n === 1 ? 'block' : 'none'};font:80px sans-serif;padding:40px">Slide ${n}</div>`).join('');
const deck = `<!doctype html><title>E2E Deck</title><body style="margin:0">${slides}<script>let i=0;const s=[...document.querySelectorAll('.s')];
addEventListener('keydown',e=>{if(e.key==='ArrowRight'&&i<s.length-1){s[i].style.display='none';i++;s[i].style.display='block';document.body.style.background=['#fff','#fdd','#dfd'][i]}})</script>`;
const clip = path.join(tmp, 'clip.mp4');
spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-t', '2', '-i', 'smptebars=s=640x360:r=24', '-f', 'lavfi', '-t', '2', '-i', 'mandelbrot=s=640x360:r=24',
  '-f', 'lavfi', '-t', '4', '-i', 'sine=f=440', '-filter_complex', '[0][1]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', clip]);

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/deck') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(deck); }
    else if (req.url.startsWith('/clip.mp4')) { res.writeHead(200, { 'Content-Type': 'video/mp4' }); fs.createReadStream(clip).pipe(res); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let win;
    for (let i = 0; i < 50 && !(win = BrowserWindow.getAllWindows()[0]); i++) await sleep(100);
    const wc = win.webContents;
    const consoleErrors = [];
    wc.on('console-message', (_e, level, msg) => { if (level >= 2) consoleErrors.push(msg); });
    if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
    await sleep(800);
    const js = (code) => wc.executeJavaScript(code);
    const waitFor = async (code, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(code)) return true; await sleep(300); } return false; };
    const snap = async (name) => fs.writeFileSync(path.join(tmp, name), (await wc.capturePage()).toPNG());

    check(await js(`['defaultDir','start','ytStatus','ytUpdate','ytDownload','ffInstall','framesStart','pickVideo','onFramesProgress'].every(k => typeof window.bd[k] === 'function')`), 'preload exposes every API the UI uses');
    check(await js(`!!document.getElementById('outDir').value && !!document.getElementById('ytOutDir').value && !!document.getElementById('frOutDir').value`), 'all three Save to folders are pre-filled');

    // Tabs + theme
    for (const t of ['video', 'frames', 'pitch', 'export']) {
      await js(`document.querySelector('.tab[data-tab=${t}]').click()`);
      const vis = await js(`['export','video','frames','pitch'].map(x => !document.getElementById('tab-'+x).hidden)`);
      check(JSON.stringify(vis) === JSON.stringify(['export', 'video', 'frames', 'pitch'].map((x) => x === t)), `switching to ${t} tab shows only that tab`);
    }
    const before = await js(`document.documentElement.dataset.theme`);
    await js(`document.getElementById('darkMode').click()`);
    const after = await js(`document.documentElement.dataset.theme`);
    const bg = await js(`getComputedStyle(document.body).backgroundColor`);
    check(before !== after && ['light', 'dark'].includes(after), `dark mode switch flips the theme (${before} -> ${after}, body ${bg})`);
    await js(`document.getElementById('darkMode').click()`);
    check(await js(`document.documentElement.dataset.theme`) === before, 'and back again');

    // Board export through the UI
    const out = path.join(tmp, 'boards');
    await js(`document.getElementById('url').value=${JSON.stringify(base + '/deck')};document.getElementById('outDir').value=${JSON.stringify(out)};
      document.getElementById('mode').value='paged';document.getElementById('settle').value='0.5';document.getElementById('fPng').checked=true;document.getElementById('go').click()`);
    check(await waitFor(`!document.getElementById('reveal').hidden || /Error/.test(document.getElementById('log').textContent)`, 90000), 'board export finishes');
    const blog = await js(`document.getElementById('log').textContent`);
    check(/Done\. 3 pages/.test(blog), 'exported 3 pages: ' + blog.split('\n').slice(-2).join(' | '));
    check(await js(`document.getElementById('strip').children.length === 3`), 'filmstrip shows 3 page thumbnails');
    await sleep(600);
    check(await js(`!document.getElementById('fill').classList.contains('indet') && document.getElementById('fill').getBoundingClientRect().width === document.getElementById('bar').getBoundingClientRect().width`), 'progress bar ends full');
    check(fs.existsSync(path.join(out, 'E2E Deck', 'E2E Deck.pdf')) && fs.readdirSync(path.join(out, 'E2E Deck', 'pages')).length === 3, 'PDF and 3 PNGs on disk');
    await snap('e2e-export.png');

    // Video tab: Install ffmpeg + yt-dlp via the buttons, then download
    await js(`document.querySelector('.tab[data-tab=video]').click()`);
    await sleep(800);
    check(await js(`!document.getElementById('ytFfInstall').hidden && document.getElementById('ytUpdate').textContent === 'Install yt-dlp'`), 'video tab offers Install ffmpeg and Install yt-dlp when missing');
    await js(`document.getElementById('ytUpdate').click()`);
    check(await waitFor(`!document.getElementById('ytUpdate').disabled && /^yt-dlp \\d/.test(document.getElementById('ytVersion').textContent)`, 120000), 'Install yt-dlp button installs it: ' + await js(`document.getElementById('ytVersion').textContent`));
    check(await js(`document.getElementById('ytUpdate').textContent === 'Update yt-dlp'`), 'button becomes "Update yt-dlp"');
    await js(`document.getElementById('ytFfInstall').click()`);
    check(await waitFor(`document.getElementById('ytFfInstall').hidden`, 180000), 'Install ffmpeg button installs it and hides itself');
    const vout = path.join(tmp, 'videos');
    await js(`document.getElementById('ytUrls').value=${JSON.stringify(base + '/clip.mp4\n' + base + '/nope.mp4')};document.getElementById('ytOutDir').value=${JSON.stringify(vout)};document.getElementById('ytGo').click()`);
    check(await waitFor(`!document.getElementById('ytGo').disabled`, 120000), 'video download finishes');
    const vlog = await js(`document.getElementById('ytLog').textContent`);
    check(/Saved 1 file/.test(vlog) && /1 link failed/.test(vlog), 'downloads the good link and lists the failed one');
    check(fs.readdirSync(vout).some((f) => f.endsWith('.mp4')), 'mp4 on disk');
    check(await js(`document.getElementById('ytItem').textContent`) === 'Done: 1 saved, 1 failed', 'status line sums up saved and failed');
    await snap('e2e-video.png');

    // Frames tab
    await js(`document.querySelector('.tab[data-tab=frames]').click()`);
    check(await waitFor(`document.getElementById('frFfStatus').textContent === 'ffmpeg ready' && document.getElementById('frFfInstall').hidden`, 5000), 'frames tab shows ffmpeg ready (installed from the other tab)');
    const fout = path.join(tmp, 'frames');
    await js(`document.getElementById('frFile').value=${JSON.stringify(clip)};document.getElementById('frOutDir').value=${JSON.stringify(fout)};document.getElementById('frGo').click()`);
    check(await waitFor(`!document.getElementById('frReveal').hidden || /Error/.test(document.getElementById('frLog').textContent)`, 120000), 'frame extraction finishes');
    const flog = await js(`document.getElementById('frLog').textContent`);
    check(/Saved 2 frames and a shot list/.test(flog), 'found 2 shots via the UI: ' + flog.split('\n').slice(-2).join(' | '));
    check(await js(`document.querySelectorAll('#frStrip img').length === 2`), 'filmstrip shows the extracted frames');
    await js(`document.getElementById('frMode').value='frames';document.getElementById('frMode').dispatchEvent(new Event('change'))`);
    check(await js(`document.getElementById('frSensWrap').hidden && !document.getElementById('frEveryWrap').hidden && document.getElementById('frEvery').value==='24'`), 'switching to every-N-frames swaps the controls');
    await js(`document.getElementById('frEvery').value='12';document.getElementById('frGo').click()`);
    check(await waitFor(`/Saved 8 frames/.test(document.getElementById('frLog').textContent)`, 60000), 'every 12 frames on a 4 s clip saves 8 frames');
    await snap('e2e-frames.png');

    // Pitch Media tab against the local Pitch mock
    const { startPitchMock } = require('./pitch-mock');
    const mock = await startPitchMock(tmp, 'pitche2e');
    // The Linux static ffmpeg build segfaults on MPEG-TS in this sandbox; use the system one for HLS.
    delete process.env.BD_IGNORE_SYSTEM_FFMPEG; process.env.BD_BIN_DIR = path.join(tmp, 'bin-empty');
    await js(`document.querySelector('.tab[data-tab=pitch]').click()`);
    check(await waitFor(`document.getElementById('pAccount').textContent === 'Not signed in to Pitch'`, 5000), 'pitch tab shows "Not signed in"');
    await mock.ses.cookies.set({ url: 'https://app.pitch.com', name: 'auth0.XYZ.is.authenticated', value: 'true' });
    await js(`document.querySelector('.tab[data-tab=export]').click();document.querySelector('.tab[data-tab=pitch]').click()`);
    check(await waitFor(`document.getElementById('pAccount').textContent === 'Signed in to Pitch' && !document.getElementById('pSignOut').hidden`, 5000), 'after signing in it shows "Signed in" and a Sign out button');
    const pout = path.join(tmp, 'pitch');
    await js(`document.getElementById('pUrl').value='https://app.pitch.com/app/presentation/A/B/C';document.getElementById('pOutDir').value=${JSON.stringify(pout)};document.getElementById('pScan').click()`);
    check(await waitFor(`!document.getElementById('pResults').hidden || /Error/.test(document.getElementById('pLog').textContent)`, 120000), 'Find media finishes');
    check(await js(`document.querySelectorAll('#pGrid .pcard').length === 3 && document.querySelectorAll('#pGrid .pcard .badge').length === 1`), 'grid shows 2 images + 1 video card');
    check(await js(`/2 images, 1 video · 3 selected/.test(document.getElementById('pSummary').textContent)`), 'summary: ' + await js(`document.getElementById('pSummary').textContent`));
    check(await js(`[...document.querySelectorAll('#pGrid .pmeta span')].some(s => s.textContent === '3000×2000')`), 'cards show original dimensions');
    await js(`document.getElementById('pShowVid').click()`);
    check(await js(`/2 selected/.test(document.getElementById('pSummary').textContent)`), 'hiding videos leaves 2 selected');
    await js(`document.getElementById('pShowVid').click();document.querySelector('#pGrid .pcard input').click()`);
    check(await js(`/2 selected/.test(document.getElementById('pSummary').textContent) && !document.querySelector('#pGrid .pcard').classList.contains('sel')`), 'unticking a card deselects it');
    await js(`document.getElementById('pGo').click()`);
    check(await waitFor(`!document.getElementById('pReveal').hidden || /Error/.test(document.getElementById('pLog').textContent)`, 120000), 'Download selected finishes');
    const plog = await js(`document.getElementById('pLog').textContent`);
    check(/Saved 2 files/.test(plog), 'saved exactly the 2 selected files: ' + plog.split('\n').slice(-2).join(' | '));
    await snap('e2e-pitch.png');
    await js(`document.querySelector('#pEmbeds button').click()`);
    check(await js(`!document.getElementById('tab-video').hidden && document.getElementById('ytUrls').value.includes('youtube-nocookie.com/embed/abc123')`), '"Send to Video Downloader" moves the embed link to the Video tab');
    mock.close();

    check(consoleErrors.length === 0, 'no errors in the renderer console' + (consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''));
  } catch (e) { console.log('ERROR ' + (e.stack || e)); fails.push('exception'); }
  server.close();
  console.log('shots in ' + tmp);
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  app.exit(fails.length ? 1 : 0);
});
