'use strict';
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const frames = require('../lib/frames');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-fr-'));
process.env.BD_BIN_DIR = path.join(tmp, 'bin');
app.on('window-all-closed', () => {});
(async () => {
  await app.whenReady();
  const fails = [];
  const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails.push(m); };
  const emit = () => {};
  try {
    // ffmpeg install button path: ignore the system ffmpeg and download our own copy
    process.env.BD_IGNORE_SYSTEM_FFMPEG = '1';
    const yt = require('../lib/ytdlp');
    let st = await yt.getStatus();
    check(!st.ffmpeg, 'status: ffmpeg missing before install');
    const ev = [];
    const ffp = await yt.ensureFfmpeg((m) => ev.push(m));
    st = await yt.getStatus();
    check(st.ffmpeg && st.ffmpegBundled && ffp === st.ffmpegPath, 'Install ffmpeg downloads a working copy: ' + ffp);
    check(ev.some((m) => typeof m.pct === 'number' && m.pct > 0 && m.pct < 100), 'install reports download progress');

    // 4 shots: 2s red-ish noise, 1.5s green, 3s blue gradient, 2s white-ish. Cuts at 2.0, 3.5, 6.5. 640x360 @ 24fps.
    const v = path.join(tmp, 'cuts.mp4');
    const src = (name, d) => ['-f', 'lavfi', '-t', String(d), '-i', `${name}=s=640x360:r=24`];
    const args = ['-y', '-loglevel', 'error', ...src('smptebars', 2), ...src('mandelbrot', 1.5), ...src('rgbtestsrc', 3), ...src('life', 2),
      '-filter_complex', '[0][1][2][3]concat=n=4:v=1:a=0,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', v];
    const g = spawnSync('ffmpeg', args);
    check(g.status === 0 && fs.existsSync(v), 'test video generated ' + (g.stderr || '').toString().slice(0, 200));

    const out = path.join(tmp, 'out');
    const { nativeImage } = require('electron');
    // Reference: decode exactly frame n of a file with ffmpeg, compare pixels to ours
    const refFrame = (file, n) => {
      const f = path.join(tmp, `ref-${path.basename(file)}-${n}.png`);
      spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-fps_mode', 'vfr', '-frames:v', '1', f]);
      return nativeImage.createFromPath(f).toBitmap();
    };
    const same = (fileA, bmpB) => Buffer.compare(nativeImage.createFromPath(fileA).toBitmap(), bmpB) === 0;

    let r = await frames.extract({ file: v, outDir: out, mode: 'scenes', threshold: 0.3, minShot: 0.5, pick: 'first', format: 'png', csv: true }, emit);
    check(r.count === 4, `scene detection found ${r.count} shots (expected 4)`);
    check(r.files.every((f) => fs.existsSync(f)), 'all frame files exist');
    const csv = fs.readFileSync(r.csv, 'utf8').split('\n');
    check(csv.filter(Boolean).length === 5, 'CSV has header + 4 rows');
    check(/^2,00:00:02:00,00:00:03:11,48,83,36,2\.000,3\.500,48,"0002_f000048\.png"$/.test(csv[2]), 'shot 2 row (inclusive end frame): ' + csv[2]);
    check(/^4,00:00:06:12,00:00:08:11,156,203,48,/.test(csv[4]), 'last shot ends on the last frame (203): ' + csv[4]);
    const firstDir = r.dir;
    check([0, 48, 84, 156].every((n, i) => same(r.files[i], refFrame(v, n))), 'first-frame picks are pixel-exact (frames 0, 48, 84, 156)');
    const sz = nativeImage.createFromPath(r.files[0]).getSize();
    check(sz.width === 640 && sz.height === 360, `frames are full resolution (${sz.width}x${sz.height})`);

    r = await frames.extract({ file: v, outDir: out, mode: 'scenes', threshold: 0.3, pick: 'last', format: 'png', csv: false }, emit);
    check(r.dir !== firstDir && /shots 2$/.test(r.dir), 'a second run goes to a new folder instead of mixing: ' + path.basename(r.dir));
    check(r.count === 4 && [47, 83, 155, 203].every((n, i) => same(r.files[i], refFrame(v, n))), 'last-frame picks are pixel-exact (47, 83, 155, 203)');

    r = await frames.extract({ file: v, outDir: out, mode: 'scenes', threshold: 0.3, pick: 'middle', format: 'jpg', csv: false }, emit);
    check(r.count === 4 && r.files[0].endsWith('.jpg') && !r.csv, 'middle-frame JPG mode works, no CSV');

    r = await frames.extract({ file: v, outDir: out, mode: 'seconds', every: 2, format: 'png' }, emit);
    check(r.count === 5, `every 2 seconds gives ${r.count} frames (expected 5)`);

    r = await frames.extract({ file: v, outDir: out, mode: 'frames', every: 24, format: 'png' }, emit);
    check(r.count === 9, `every 24 frames gives ${r.count} frames (expected 9)`);
    check([0, 1, 2, 5, 8].every((k) => same(r.files[k], refFrame(v, k * 24))), 'every-N-frames picks are pixel-exact');

    // The Linux static ffmpeg build segfaults on MPEG-TS in this sandbox; use the system ffmpeg from here on.
    delete process.env.BD_IGNORE_SYSTEM_FFMPEG; process.env.BD_BIN_DIR = path.join(tmp, 'bin-empty');
    // Transport stream: non-zero start time (ffmpeg reports start ~1.4s)
    const ts = path.join(tmp, 'cuts.ts');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', v, '-c', 'copy', '-f', 'mpegts', ts]);
    r = await frames.extract({ file: ts, outDir: out, mode: 'scenes', threshold: 0.3, csv: true }, emit);
    const tsCsv = fs.readFileSync(r.csv, 'utf8').split('\n');
    check(r.count === 4 && /^2,00:00:02:00,/.test(tsCsv[2]), 'file with a non-zero start time gets correct cut times: ' + tsCsv[2]);
    check(same(r.files[1], refFrame(ts, 48)), 'and the right frame (48)');

    const mp4Run = await frames.extract({ file: v, outDir: out, mode: 'seconds', every: 0.7, format: 'png' }, emit);
    const tsRun = await frames.extract({ file: ts, outDir: out, mode: 'seconds', every: 0.7, format: 'png' }, emit);
    check(mp4Run.count === tsRun.count && mp4Run.files.every((f, i) => path.basename(f) === path.basename(tsRun.files[i])), `seek and single-pass pick the same frames (${tsRun.count} every 0.7s)`);
    check(mp4Run.files.every((f, i) => same(f, nativeImage.createFromPath(tsRun.files[i]).toBitmap())), 'and identical pixels');
    check(!fs.readdirSync(tsRun.dir).some((f) => f.startsWith('.bd-')), 'no temp files left behind');

    // NTSC 23.976
    const ntsc = path.join(tmp, 'ntsc.mp4');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-t', '3', '-i', 'testsrc2=s=320x180:r=24000/1001', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ntsc]);
    const info = await frames.probe(require('../lib/ytdlp').findFfmpeg(), ntsc);
    check(Math.abs(info.fps - 24000 / 1001) < 1e-9, `23.976 detected exactly (${info.fps})`);

    let err = null;
    try { await frames.extract({ file: path.join(tmp, 'nope.mp4'), outDir: out }, emit); } catch (e) { err = e; }
    check(err && /Choose a video/.test(err.message), 'missing file gives a clear error');
    fs.writeFileSync(path.join(tmp, 'bad.mp4'), 'not a video');
    err = null;
    try { await frames.extract({ file: path.join(tmp, 'bad.mp4'), outDir: out }, emit); } catch (e) { err = e; }
    check(!!err, 'non-video file errors out');
    err = null;
    try { await frames.extract({ file: v, outDir: out, mode: 'frames', every: 1, maxFrames: 10 }, emit); } catch (e) { err = e; }
    check(err && /limit/.test(err.message), 'frame-count safety limit works');
  } catch (e) { console.log('ERROR ' + (e.stack || e)); fails.push('exception'); }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  app.exit(fails.length ? 1 : 0);
})();
