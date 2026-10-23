'use strict';
// Exercises the video downloader backend with the real yt-dlp binary against a local test video.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-yt-'));
process.env.BD_BIN_DIR = path.join(tmp, 'bin');
process.env.no_proxy = '127.0.0.1,localhost'; process.env.NO_PROXY = process.env.no_proxy;
const yt = require('../lib/ytdlp');

app.on('window-all-closed', () => {});
(async () => {
  await app.whenReady();
  const fails = [];
  const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
  const events = [];
  const emit = (m) => events.push(m);
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(tmp, 'clip.mp4')]);
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/clip.mp4')) { res.writeHead(200, { 'Content-Type': 'video/mp4' }); fs.createReadStream(path.join(tmp, 'clip.mp4')).pipe(res); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    let st = await yt.getStatus();
    check(st.ytdlp === null, 'status: yt-dlp not installed at first');

    const inst = await yt.installOrUpdate(emit);
    check(inst.updated && !!inst.after, `install downloads and verifies yt-dlp (${inst.after})`);
    st = await yt.getStatus();
    check(st.ytdlp === inst.after, 'status reports installed version');

    const again = await yt.installOrUpdate(emit);
    check(!again.updated && /up to date/.test(events[events.length - 1].msg || ''), 'update button: reports already up to date');

    // Force an "old" version to prove the update path replaces the binary
    fs.writeFileSync(yt.ytPath(), '#!/bin/sh\necho 2020.01.01\n'); fs.chmodSync(yt.ytPath(), 0o755);
    const upd = await yt.installOrUpdate(emit);
    check(upd.updated && upd.before === '2020.01.01' && upd.after === inst.after, `update replaces an outdated binary (${upd.before} -> ${upd.after})`);

    const out = path.join(tmp, 'out');
    events.length = 0;
    let r = await yt.download({ urls: [`http://127.0.0.1:${port}/clip.mp4`], quality: 'compat', outDir: out }, emit);
    check(r.files.length === 1 && fs.existsSync(r.files[0]), 'video download saved a file: ' + (r.files[0] ? path.basename(r.files[0]) : 'none'));
    check(events.some((e) => e.kind === 'progress'), 'progress events emitted');

    r = await yt.download({ urls: [`http://127.0.0.1:${port}/clip.mp4`], quality: 'mp3', outDir: out }, emit);
    check(r.files.length === 1 && /\.mp3$/.test(r.files[0]) && fs.existsSync(r.files[0]), 'audio-only MP3 extraction works');

    let err = null;
    try { await yt.download({ urls: ['-oops'], outDir: out }, emit); } catch (e) { err = e; }
    check(err && /full web address/.test(err.message), 'rejects links that are not http(s)');
    err = null;
    try { await yt.download({ urls: [`http://127.0.0.1:${port}/missing.mp4`], outDir: out }, emit); } catch (e) { err = e; }
    check(!!err, 'bad link surfaces an error: ' + (err ? err.message.split('\n')[0].slice(0, 80) : ''));
    check(err && !/wants a login/.test(err.message), 'a 404 does not wrongly suggest logging in');

    // Batch: one bad link must not stop the good ones
    r = await yt.download({ urls: [`http://127.0.0.1:${port}/missing.mp4`, `http://127.0.0.1:${port}/clip.mp4?x=2`], quality: '720', outDir: path.join(tmp, 'batch') }, emit);
    check(r.files.length === 1 && r.failed.length === 1 && /missing/.test(r.failed[0].url), 'batch keeps going past a failed link and reports it');
    err = null;
    try { await yt.download({ urls: [`http://127.0.0.1:${port}/a.mp4`, `http://127.0.0.1:${port}/b.mp4`], outDir: out }, emit); } catch (e) { err = e; }
    check(err && /None of the 2/.test(err.message), 'all links failing gives one clear error');

    // Two tabs asking for ffmpeg/yt-dlp at once share one install
    const [p1, p2] = [yt.installOrUpdate(() => {}), yt.installOrUpdate(() => {})];
    const [a1, a2] = await Promise.all([p1, p2]);
    check(a1 === a2, 'simultaneous update clicks share one run');
    server.close();
  } catch (e) {
    console.log('ERROR ' + (e.stack || e));
    fails.push('exception');
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  app.exit(fails.length ? 1 : 0);
})();
