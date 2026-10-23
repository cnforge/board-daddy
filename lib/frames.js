'use strict';
// Frame extraction + scene detection (ffmpeg). Full-resolution frames, one ffmpeg call per frame.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const yt = require('./ytdlp');

let cancelled = false;
let procs = new Set();

function cancel() { cancelled = true; for (const p of procs) { try { p.kill('SIGTERM'); } catch (e) { /* ignore */ } } }

function exec(bin, args, { onErr, onOut } = {}) {
  return new Promise((resolve, reject) => {
    let err = '';
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(e); return; }
    procs.add(child);
    child.stdout.on('data', (d) => { if (onOut) onOut(String(d)); });
    child.stderr.on('data', (d) => { const s = String(d); err += s; if (err.length > 400000) err = err.slice(-200000); if (onErr) onErr(s); });
    child.on('error', (e) => { procs.delete(child); reject(e); });
    child.on('close', (code) => { procs.delete(child); resolve({ code, err }); });
  });
}

// Duration, fps and size from `ffmpeg -i` (no ffprobe needed).
async function probe(ff, file) {
  const { code, err } = await exec(ff, ['-hide_banner', '-i', file]);
  if (code === null || code > 128) throw new Error('ffmpeg crashed while reading this file. Try Install ffmpeg (or a Homebrew ffmpeg), or re-export the video as MP4/MOV.');
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  const duration = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0;
  const v = /Stream #\S+.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(err);
  const f = /(\d+(?:\.\d+)?)\s*fps/.exec(err) || /(\d+(?:\.\d+)?)\s*tbr/.exec(err);
  if (!v) throw new Error('That file has no video track ffmpeg can read.');
  return { duration, width: +v[1], height: +v[2], fps: exactFps(f ? parseFloat(f[1]) : 25) };
}

// ffmpeg prints NTSC rates rounded (23.98), which drifts ~9 frames an hour; use the exact ratio.
function exactFps(f) {
  for (const n of [24, 30, 48, 60, 120]) if (Math.abs(f - n * 1000 / 1001) < 0.006) return n * 1000 / 1001;
  return f;
}

function tc(sec, fps) {
  const n = Math.round(fps) || 25;
  const total = Math.round(sec * n);
  const f = total % n, s = Math.floor(total / n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
}

// Returns cut times in seconds (start of each new shot), threshold 0..1 (lower = more sensitive).
async function detectCuts(ff, file, info, threshold, minShot, emit) {
  const cuts = [];
  const vf = `scale=640:-2:flags=fast_bilinear,select='gt(scene,${threshold})',showinfo`;
  let buf = '';
  const onErr = (s) => {
    buf += s;
    const lines = buf.split(/\r|\n/); buf = lines.pop();
    for (const l of lines) {
      const m = /pts_time:(\d+(?:\.\d+)?)/.exec(l);
      if (m && /Parsed_showinfo/.test(l)) cuts.push(parseFloat(m[1])); // ffmpeg already rebases to 0
    }
  };
  let out = '';
  const onOut = (s) => {
    out += s;
    const parts = out.split('\n'); out = parts.pop();
    for (const l of parts) {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
      if (m && info.duration) emit({ kind: 'progress', phase: 'detect', pct: Math.min(99, (+m[1] / 1e6 / info.duration) * 100), msg: `Looking for cuts… ${cuts.length} found` });
    }
  };
  const r = await exec(ff, ['-hide_banner', '-nostdin', '-progress', 'pipe:1', '-nostats', '-i', file, '-an', '-sn', '-vf', vf, '-fps_mode', 'vfr', '-f', 'null', '-'], { onErr, onOut });
  if (cancelled) throw new Error('Cancelled.');
  if (r.code !== 0) throw new Error('Scene detection failed: ' + r.err.split('\n').filter(Boolean).slice(-2).join(' '));
  // merge cuts that land too close together
  const kept = [];
  let prev = 0;
  for (const c of cuts.sort((a, b) => a - b)) {
    if (c - prev >= minShot && (!info.duration || info.duration - c >= minShot)) { kept.push(c); prev = c; }
  }
  return kept;
}

async function extractOne(ff, file, t, dest, fmt, quality) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-an', '-sn'];
  if (fmt === 'jpg') args.push('-q:v', String(quality || 2));
  args.push(dest);
  const r = await exec(ff, args);
  if (r.code !== 0 || !fs.existsSync(dest)) throw new Error('Could not extract a frame at ' + t.toFixed(2) + 's. ' + r.err.split('\n')[0]);
}

// One decode pass that keeps exactly the wanted frame numbers. Returns how many were written.
async function extractPass(ff, file, rows, dir, o, info, emit) {
  const want = rows.map((r) => r.pick);
  const tmpl = path.join(dir, `.bd-pass-%06d.${o.format === 'jpg' ? 'jpg' : 'png'}`);
  // Fits on the command line even at the 5000-frame limit (~70 KB).
  const select = 'select=' + want.map((n) => `eq(n\\,${n})`).join('+');
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y', '-i', file, '-an', '-sn',
    '-vf', select, '-fps_mode', 'vfr'];
  if (o.format === 'jpg') args.push('-q:v', '2');
  args.push(tmpl);
  let buf = '';
  const r = await exec(ff, args, {
    onOut: (s) => {
      buf += s; const parts = buf.split('\n'); buf = parts.pop();
      for (const l of parts) {
        const m = /^frame=(\d+)/.exec(l);
        if (m) emit({ kind: 'progress', phase: 'extract', pct: Math.min(99, (+m[1] / want.length) * 100), msg: `Decoding… ${m[1]} of ${want.length} frames` });
      }
    },
  });
  if (cancelled) throw new Error('Cancelled.');
  if (r.code !== 0) throw new Error('Frame extraction failed: ' + r.err.split('\n').filter(Boolean).slice(-2).join(' '));
  let got = 0;
  for (let i = 0; i < rows.length; i++) {
    const src = tmpl.replace('%06d', String(i + 1).padStart(6, '0'));
    if (!fs.existsSync(src)) break;
    fs.renameSync(src, path.join(dir, rows[i].file));
    got++;
  }
  return got;
}

function thumbOf(file) {
  try {
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    return img.resize({ width: 200, quality: 'good' }).toDataURL();
  } catch (e) { return null; }
}

const csvq = (s) => '"' + String(s).replace(/"/g, '""') + '"';

// opts: { file, outDir, mode: 'scenes'|'seconds'|'frames', threshold, minShot, pick: 'first'|'middle'|'last',
//         every, format: 'png'|'jpg', csv, maxFrames }
async function extract(raw, emit) {
  cancelled = false;
  const o = {
    mode: 'scenes', threshold: 0.3, minShot: 0.5, pick: 'first', every: 1, format: 'png', csv: true, maxFrames: 5000, ...raw,
  };
  if (!o.file || !fs.existsSync(o.file)) throw new Error('Choose a video file first.');
  if (!o.outDir) throw new Error('Choose where to save the frames.');
  o.threshold = Math.min(0.95, Math.max(0.02, Number(o.threshold) || 0.3));
  o.every = Math.max(0.001, Number(o.every) || 1);
  o.minShot = Math.max(0, Number(o.minShot) || 0);
  const ff = await yt.ensureFfmpeg((m) => emit({ ...m, kind: 'setup' }));
  const info = await probe(ff, o.file);
  emit({ kind: 'info', ...info, msg: `${info.width}×${info.height}, ${info.fps} fps, ${info.duration.toFixed(1)}s` });

  // Work in whole frame numbers (frame 0 = first frame), so every mode is frame-exact.
  const dur = info.duration || 0;
  const fps = info.fps || 25;
  const total = Math.max(1, Math.round(dur * fps));
  const rows = []; // { start, end } are frame numbers, end exclusive; pick = frame to extract
  if (o.mode === 'scenes') {
    const cuts = await detectCuts(ff, o.file, info, o.threshold, o.minShot, emit);
    const edges = [0, ...cuts.map((c) => Math.round(c * fps)).filter((f) => f > 0 && f < total), total];
    for (let i = 0; i < edges.length - 1; i++) {
      const start = edges[i], end = edges[i + 1];
      if (end <= start) continue;
      const pick = o.pick === 'middle' ? Math.floor((start + end - 1) / 2) : o.pick === 'last' ? end - 1 : start;
      rows.push({ start, end, pick });
    }
    emit({ kind: 'log', msg: `Found ${rows.length - 1} cut${rows.length === 2 ? '' : 's'} → ${rows.length} shot${rows.length === 1 ? '' : 's'}.` });
  } else {
    const picks = [];
    if (o.mode === 'frames') {
      const n = Math.max(1, Math.round(o.every));
      for (let f = 0; f < total; f += n) picks.push(f);
    } else {
      const S = Math.max(1, o.every * fps); // frames per step
      for (let f = 0; f < total; f++) if (Math.floor((f + 0.5) / S) > Math.floor((f - 0.5) / S)) picks.push(f);
    }
    picks.forEach((f, i) => rows.push({ start: f, end: i + 1 < picks.length ? picks[i + 1] : total, pick: f }));
  }
  if (rows.length > o.maxFrames) throw new Error(`That would create ${rows.length} frames (limit ${o.maxFrames}). Use a larger interval or a higher scene threshold.`);

  const base = path.basename(o.file).replace(/\.[^.]+$/, '');
  // Never mix a new run into an older run's folder.
  const stem = path.join(o.outDir, base + (o.mode === 'scenes' ? ' - shots' : ' - frames'));
  let dir = stem;
  for (let k = 2; fs.existsSync(dir) && fs.readdirSync(dir).length; k++) dir = `${stem} ${k}`;
  fs.mkdirSync(dir, { recursive: true });
  const ext = o.format === 'jpg' ? 'jpg' : 'png';
  rows.forEach((r, i) => { r.n = i + 1; r.file = `${String(i + 1).padStart(4, '0')}_f${String(r.pick).padStart(6, '0')}.${ext}`; });

  const done = (r, i) => emit({ kind: 'progress', phase: 'extract', pct: ((i + 1) / rows.length) * 100, msg: `Frame ${i + 1} of ${rows.length}`, thumb: thumbOf(path.join(dir, r.file)), index: i + 1, count: rows.length, at: tc(r.pick / fps, fps) });
  // MPEG transport/program streams (.ts .mts .m2ts .mpg …) can't be seeked reliably, so
  // they are decoded once from the start and frames are picked by number.
  let onePass = /\.(m2?ts|mts|m2t|ts|mpe?g|vob|m2v|mod|tod|flv|wmv|asf)$/i.test(o.file);
  if (!onePass) {
    const frameDur = 1 / fps;
    for (let i = 0; i < rows.length; i++) {
      if (cancelled) throw new Error('Cancelled.');
      // Accurate seek returns the first frame at or after t; start a quarter frame early so rounding never skips it.
      const t = Math.max(0, rows[i].pick / fps - frameDur * 0.25);
      try { await extractOne(ff, o.file, t, path.join(dir, rows[i].file), o.format); } catch (e) {
        if (cancelled) throw new Error('Cancelled.');
        emit({ kind: 'log', msg: 'Seeking is unreliable in this file, switching to a single pass from the start…' });
        onePass = true; break;
      }
      done(rows[i], i);
    }
  }
  if (onePass) {
    const got = await extractPass(ff, o.file, rows, dir, o, info, emit);
    if (got < rows.length) {
      emit({ kind: 'log', msg: `The video ended early: ${rows.length - got} requested frame${rows.length - got === 1 ? '' : 's'} past the end were skipped.` });
      rows.length = got;
    }
    rows.forEach(done);
  }
  if (!rows.length) throw new Error('No frames could be extracted from this file.');

  let csvPath = null;
  if (o.csv) {
    // start/end are inclusive frame numbers (frame 0 = first frame of the file).
    const head = 'shot,start_tc,end_tc,start_frame,end_frame,frame_count,start_sec,end_sec,extracted_frame,frame_file';
    const lines = rows.map((r) => [r.n, tc(r.start / fps, fps), tc((r.end - 1) / fps, fps), r.start, r.end - 1, r.end - r.start,
      (r.start / fps).toFixed(3), (r.end / fps).toFixed(3), r.pick, csvq(r.file)].join(','));
    csvPath = path.join(dir, (o.mode === 'scenes' ? 'shots' : 'frames') + '.csv');
    fs.writeFileSync(csvPath, [head, ...lines].join('\n') + '\n');
  }
  return { dir, count: rows.length, csv: csvPath, files: rows.map((r) => path.join(dir, r.file)), fps };
}

module.exports = { extract, cancel, probe, tc };
