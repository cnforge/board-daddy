'use strict';
// Pitch Media test against a local mock of Pitch (same hostnames, served over HTTPS
// through a local proxy): imgproxy originals, Mux HLS video, editor slide list, login wall.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-pitch-'));
process.env.BD_PITCH_PARTITION = 'pitchtest';
const { app, session, nativeImage } = require('electron');
const pitch = require('../lib/pitch');
const { startPitchMock } = require('./pitch-mock');
app.on('window-all-closed', () => {});

const fails = [];
const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
const ff = (args) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);

app.whenReady().then(async () => {
  const { A, ses } = await startPitchMock(tmp, 'pitchtest');
  const events = [];
  const emit = (m) => events.push(m);
  try {
    check(!(await pitch.isSignedIn()), 'not signed in at first');
    await ses.cookies.set({ url: 'https://app.pitch.com', name: 'auth0.XYZ.is.authenticated', value: 'true' });
    check(await pitch.isSignedIn(), 'sign-in detected from Pitch\'s auth cookie');

    let err = null;
    try { await pitch.scan({ url: 'https://app.pitch.com/app/presentation/LOCKED/x/y', settleMs: 300 }, emit, () => false); } catch (e) { err = e; }
    check(err && err.code === 'NEEDS_LOGIN', 'a link that bounces to the Pitch login asks you to sign in');

    const t0 = Date.now();
    const r = await pitch.scan({ url: 'https://app.pitch.com/app/presentation/A/B/C', settleMs: 300 }, emit, () => false);
    console.log(`  scan took ${((Date.now() - t0) / 1000).toFixed(1)}s, items: ` + r.items.map((x) => `${x.kind} ${x.w}x${x.h} ${x.bytes}`).join(' | '));
    check(r.title === 'Mock Deck', 'deck title read: ' + r.title);
    const imgs = r.items.filter((x) => x.kind === 'image');
    check(imgs.length === 2, `found the 2 content images (tiny logo and app chrome skipped): ${imgs.length}`);
    check(imgs.some((x) => x.w === 3000 && x.h === 2000 && x.type === 'image/png') && imgs.some((x) => x.w === 2400 && x.h === 1600 && x.type === 'image/jpeg'), 'reports original sizes and formats (3000x2000 PNG, 2400x1600 JPG), not the 600px previews');
    check(imgs.every((x) => /\/raw:1\/plain\/pitch-assets-/.test(x.url)), 'image URLs point at the raw originals');
    check(imgs.every((x) => x.thumb && x.thumb.startsWith('data:image/jpeg')), 'image thumbnails present');
    const vid = r.items.find((x) => x.kind === 'hls');
    check(vid && vid.w === 1920 && vid.h === 1080 && vid.thumb, 'Mux video found, best rendition 1920x1080 (listed second), with thumbnail');
    check(r.items.some((x) => x.kind === 'embed' && /youtube-nocookie\.com\/embed\/abc123/.test(x.url)), 'YouTube embed listed for the Video Downloader');
    check(events.some((e) => /Slide 3 of 3/.test(e.msg || '')), 'walked all 3 slides via the slide list');

    const out = path.join(tmp, 'out');
    const d = await pitch.download({ items: r.items, outDir: out, title: r.title }, emit);
    console.log('  saved: ' + d.files.map((f) => path.relative(out, f)).join(', '));
    check(d.files.length === 3 && d.failed.length === 0, '3 files saved (2 images + 1 video), embed left for the Video Downloader');
    const png = d.files.find((f) => f.endsWith('.png'));
    check(png && Buffer.compare(fs.readFileSync(png), fs.readFileSync(path.join(A, 'orig1.png'))) === 0, 'saved PNG is byte-identical to the original upload');
    const jpg = d.files.find((f) => f.endsWith('.jpg'));
    check(jpg && Buffer.compare(fs.readFileSync(jpg), fs.readFileSync(path.join(A, 'orig2.jpg'))) === 0, 'saved JPG is byte-identical to the original upload');
    const mp4 = d.files.find((f) => f.endsWith('.mp4'));
    const probe = mp4 ? spawnSync('ffmpeg', ['-hide_banner', '-i', mp4]).stderr.toString() : '';
    check(/1920x1080/.test(probe) && /Audio: aac/.test(probe), 'video saved as MP4 from the 1080p rendition with audio');
    check(/Duration: 00:00:0[23]/.test(probe), 'full length video: ' + ((/Duration: [\d:.]+/.exec(probe) || [])[0]));
    check(d.files.every((f) => f.startsWith(path.join(out, 'Mock Deck'))) && d.files.some((f) => /\/images\//.test(f)) && d.files.some((f) => /\/videos\//.test(f)), 'saved into <deck>/images and <deck>/videos');
    const d2 = await pitch.download({ items: r.items.filter((x) => x.kind === 'image').slice(0, 1), outDir: out, title: r.title }, emit);
    check(/Mock Deck 2$/.test(d2.dir), 'a second download goes to a new folder');
  } catch (e) { console.log('ERROR ' + (e.stack || e)); fails.push('exception'); }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  app.exit(fails.length ? 1 : 0);
});
