'use strict';
// Video downloader backend: manages the yt-dlp (and ffmpeg) binaries and runs downloads.
// yt-dlp is https://github.com/yt-dlp/yt-dlp. Binaries are fetched on demand into the
// app's data folder, never bundled, so the Update button can always pull the newest one.

const { app, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const GH = 'https://github.com/yt-dlp/yt-dlp/releases';
const FF_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';
const COOKIE_BROWSERS = ['safari', 'chrome', 'firefox', 'brave', 'edge', 'chromium', 'vivaldi', 'opera'];
const QUALITIES = ['compat', 'best', '720', 'mp3', 'm4a'];

let current = null;     // running yt-dlp child
let cancelled = false;

// ---------- locations ----------
function binDir() { return process.env.BD_BIN_DIR || path.join(app.getPath('userData'), 'bin'); }
const exe = (n) => (process.platform === 'win32' ? n + '.exe' : n);
const ytPath = () => path.join(binDir(), exe('yt-dlp'));
const ffPath = () => path.join(binDir(), exe('ffmpeg'));

function ytAsset() {
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  if (process.platform === 'win32') return 'yt-dlp.exe';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}
function ffAsset() {
  const a = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `ffmpeg-darwin-${a}`;
  if (process.platform === 'win32') return 'ffmpeg-win32-x64';
  return `ffmpeg-linux-${a}`;
}
function findFfmpeg() {
  const cands = process.env.BD_IGNORE_SYSTEM_FFMPEG ? [ffPath()] : [ffPath(), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  return cands.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (e) { return false; } }) || null;
}

// ---------- small helpers ----------
function run(bin, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out, err: String(e) }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function versionOf(bin) {
  if (!fs.existsSync(bin)) return null;
  const r = await run(bin, ['--version'], { timeoutMs: 20000 });
  return r.code === 0 ? r.out.trim() : null;
}

async function fetchToFile(url, dest, { onProgress, gunzip } = {}) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'BoardDaddy' } });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const hash = crypto.createHash('sha256');
  const counter = new Transform({
    transform(chunk, _enc, cb) { got += chunk.length; hash.update(chunk); if (onProgress) onProgress(got, total); cb(null, chunk); },
  });
  const chain = [Readable.fromWeb(res.body), counter];
  if (gunzip) chain.push(zlib.createGunzip());
  chain.push(fs.createWriteStream(dest));
  try { await pipeline(...chain); } catch (e) { fs.rmSync(dest, { force: true }); throw new Error('Download interrupted: ' + e.message); }
  return hash.digest('hex'); // hash of the bytes as downloaded
}

function tagFromRedirect() {
  // /releases/latest redirects to /releases/tag/<version>; read where it points.
  return new Promise((resolve, reject) => {
    const req = net.request({ url: `${GH}/latest`, method: 'HEAD', redirect: 'manual' });
    req.on('redirect', (_status, _method, redirectUrl) => {
      const m = /\/tag\/([^/?#]+)/.exec(redirectUrl || '');
      try { req.abort(); } catch (e) { /* ignore */ }
      if (m) resolve(decodeURIComponent(m[1])); else reject(new Error('No release tag in redirect.'));
    });
    req.on('response', () => reject(new Error('No redirect from the releases page.')));
    req.on('error', reject);
    req.end();
  });
}

async function latestTag() {
  try { return await tagFromRedirect(); } catch (e) { /* fall back to the API */ }
  try {
    const res = await net.fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', { headers: { 'User-Agent': 'BoardDaddy', Accept: 'application/vnd.github+json' } });
    if (res.ok) { const j = await res.json(); if (j.tag_name) return j.tag_name; }
  } catch (e) { /* fall through */ }
  throw new Error('Could not check the latest yt-dlp version. Check your internet connection.');
}

async function expectedSha(tag, asset) {
  const res = await net.fetch(`${GH}/download/${tag}/SHA2-256SUMS`, { headers: { 'User-Agent': 'BoardDaddy' } });
  if (!res.ok) throw new Error('Could not fetch the yt-dlp checksum file.');
  for (const line of (await res.text()).split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === asset) return m[1];
  }
  throw new Error('No checksum published for this yt-dlp build.');
}

// ---------- status / install / update ----------
async function getStatus() {
  const ff = findFfmpeg();
  return { ytdlp: await versionOf(ytPath()), ffmpeg: !!ff, ffmpegPath: ff, ffmpegBundled: !!ff && ff === ffPath(), dir: binDir() };
}

// Installs yt-dlp if missing, or updates it to the newest release. Verified by SHA-256.
// One install at a time, even if two tabs ask for it at once.
const inflight = {};
function once(key, fn) {
  if (!inflight[key]) inflight[key] = fn().finally(() => { delete inflight[key]; });
  return inflight[key];
}
const installOrUpdate = (emit) => once('yt', () => installOrUpdateNow(emit));
const ensureFfmpeg = (emit) => (findFfmpeg() ? Promise.resolve(findFfmpeg()) : once('ff', () => ensureFfmpegNow(emit)));

async function installOrUpdateNow(emit) {
  const before = await versionOf(ytPath());
  emit({ kind: 'setup', msg: 'Checking the latest yt-dlp release…' });
  const tag = await latestTag();
  if (before && before === tag) {
    emit({ kind: 'setup', msg: `yt-dlp is already up to date (${before}).` });
    return { before, after: before, updated: false };
  }
  const asset = ytAsset();
  const expected = await expectedSha(tag, asset);
  fs.mkdirSync(binDir(), { recursive: true });
  const tmp = ytPath() + '.download';
  emit({ kind: 'setup', msg: `Downloading yt-dlp ${tag}…`, pct: 0 });
  let last = 0;
  const hash = await fetchToFile(`${GH}/download/${tag}/${asset}`, tmp, {
    onProgress: (got, total) => {
      const pct = total ? Math.round((got / total) * 100) : 0;
      if (pct !== last) { last = pct; emit({ kind: 'setup', pct }); }
    },
  });
  if (hash !== expected) { fs.rmSync(tmp, { force: true }); throw new Error('Checksum mismatch, so the download was discarded.'); }
  fs.chmodSync(tmp, 0o755);
  const v = await versionOf(tmp);
  if (!v) { fs.rmSync(tmp, { force: true }); throw new Error('The downloaded yt-dlp would not start.'); }
  const old = ytPath() + '.old';
  if (fs.existsSync(ytPath())) fs.renameSync(ytPath(), old);
  fs.renameSync(tmp, ytPath());
  fs.rmSync(old, { force: true });
  emit({ kind: 'setup', msg: before ? `Updated yt-dlp ${before} → ${v}.` : `Installed yt-dlp ${v}.`, pct: 100 });
  return { before, after: v, updated: true };
}

async function ensureFfmpegNow(emit) {
  if (findFfmpeg()) return findFfmpeg();
  emit({ kind: 'setup', msg: 'Downloading ffmpeg (one time, about 30 MB)…', pct: 0 });
  fs.mkdirSync(binDir(), { recursive: true });
  const tmp = ffPath() + '.download';
  let last = 0;
  await fetchToFile(`${FF_RELEASE}/${ffAsset()}.gz`, tmp, {
    gunzip: true,
    onProgress: (got, total) => {
      const pct = total ? Math.round((got / total) * 100) : 0;
      if (pct !== last) { last = pct; emit({ kind: 'setup', pct }); }
    },
  });
  fs.chmodSync(tmp, 0o755);
  const r = await run(tmp, ['-version']);
  if (r.code !== 0) { fs.rmSync(tmp, { force: true }); throw new Error('The downloaded ffmpeg would not start.'); }
  fs.renameSync(tmp, ffPath());
  emit({ kind: 'setup', msg: 'ffmpeg installed.', pct: 100 });
  return ffPath();
}

// ---------- downloading ----------
function formatArgs(q) {
  switch (q) {
    case 'best': return ['-f', 'bv*+ba/b', '--merge-output-format', 'mkv'];
    case '720': return ['-f', 'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4'];
    case 'mp3': return ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
    case 'm4a': return ['-x', '--audio-format', 'm4a'];
    default: return ['-f', 'bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba/b', '--merge-output-format', 'mp4'];
  }
}

function cookieArgs(browser) {
  return browser && COOKIE_BROWSERS.includes(browser) ? ['--cookies-from-browser', browser] : [];
}

async function lookup(bin, url, opts) {
  const args = ['--ignore-config', '--no-warnings', '--skip-download', '--no-playlist',
    '--print', '%(title)s\t%(uploader)s\t%(duration_string)s\t%(thumbnail)s', ...cookieArgs(opts.cookies), '--', url];
  const r = await run(bin, args, { timeoutMs: 45000 });
  if (r.code !== 0) return null;
  const [title, uploader, duration, thumb] = r.out.trim().split('\n')[0].split('\t');
  let thumbnail = null;
  if (thumb && /^https?:\/\//.test(thumb)) {
    try {
      const res = await net.fetch(thumb);
      if (res.ok) thumbnail = `data:${res.headers.get('content-type') || 'image/jpeg'};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
    } catch (e) { /* thumbnail is optional */ }
  }
  return { title, uploader, duration, thumbnail };
}

function hint(stderr) {
  if (/operation not permitted|full disk access/i.test(stderr)) return 'macOS blocked access to browser cookies. Give Board Daddy Full Disk Access in System Settings > Privacy & Security, or pick Chrome or Firefox instead.';
  if (/login|log in|sign in|cookies|rate-limit|private video|\bage\b|age-restricted|inappropriate|confirm you.re not a bot/i.test(stderr)) return 'This site wants a login. Pick the browser you are signed in with under "Use browser login" and try again.';
  return '';
}

function runOne(bin, url, opts, ffmpeg, emit) {
  return new Promise((resolve, reject) => {
    const listFile = path.join(os.tmpdir(), `bd-path-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const args = [
      '--ignore-config', '--newline', '--no-colors',
      opts.playlist ? '--yes-playlist' : '--no-playlist',
      ...formatArgs(opts.quality),
      '--ffmpeg-location', ffmpeg,
      '-o', path.join(opts.outDir, '%(title).120B [%(id)s].%(ext)s'),
      '--progress-template', 'download:BDP %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s',
      '--print-to-file', 'after_move:filepath', listFile,
      ...cookieArgs(opts.cookies),
      '--', url,
    ];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    let errText = '';
    const onLine = (line) => {
      line = line.trim();
      if (!line) return;
      if (line.startsWith('BDP ')) {
        const [, d, t, te, sp, eta] = line.split(' ');
        const num = (x) => (x && x !== 'NA' && !isNaN(Number(x)) ? Number(x) : 0);
        const total = num(t) || num(te);
        emit({ kind: 'progress', pct: total ? Math.min(100, (num(d) / total) * 100) : 0, speed: num(sp), eta: num(eta) });
      } else {
        emit({ kind: 'log', msg: line });
      }
    };
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; const parts = buf.split('\n'); buf = parts.pop(); parts.forEach(onLine); });
    child.stderr.on('data', (d) => { errText += d; String(d).split('\n').forEach((l) => { if (l.trim()) emit({ kind: 'log', msg: l.trim() }); }); });
    child.on('error', (e) => { current = null; reject(e); });
    child.on('close', (code) => {
      current = null;
      if (buf) onLine(buf);
      let files = [];
      try { files = fs.readFileSync(listFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean); } catch (e) { /* none */ }
      fs.rmSync(listFile, { force: true });
      if (cancelled) return reject(new Error('Cancelled.'));
      if (code !== 0) {
        const line = errText.split('\n').reverse().find((l) => /^ERROR:/.test(l.trim())) || 'yt-dlp failed.';
        return reject(new Error(line.replace(/^ERROR:\s*/, '').slice(0, 300) + (hint(errText) ? '\n' + hint(errText) : '')));
      }
      resolve(files);
    });
  });
}

async function download(rawOpts, emit) {
  const opts = { quality: 'compat', cookies: '', playlist: false, ...rawOpts };
  const urls = (opts.urls || []).map((u) => String(u).trim()).filter(Boolean);
  if (!urls.length) throw new Error('Paste at least one video link.');
  for (const u of urls) if (!/^https?:\/\//i.test(u)) throw new Error(`"${u.slice(0, 60)}" is not a full web address (it must start with http:// or https://).`);
  if (!QUALITIES.includes(opts.quality)) throw new Error('Unknown quality option.');
  if (!opts.outDir) throw new Error('Choose a folder to save to.');
  fs.mkdirSync(opts.outDir, { recursive: true });
  cancelled = false;

  if (!(await versionOf(ytPath()))) await installOrUpdate(emit);
  const ffmpeg = await ensureFfmpeg(emit);
  const bin = ytPath();

  const saved = [];
  const failed = [];
  for (let i = 0; i < urls.length; i++) {
    if (cancelled) break;
    emit({ kind: 'item', index: i + 1, count: urls.length, url: urls[i] });
    emit({ kind: 'log', msg: `Looking up video ${i + 1} of ${urls.length}…` });
    const info = await lookup(bin, urls[i], opts).catch(() => null);
    if (info) emit({ kind: 'info', ...info });
    try {
      const files = await runOne(bin, urls[i], opts, ffmpeg, emit);
      saved.push(...files);
      emit({ kind: 'itemDone', index: i + 1, count: urls.length });
    } catch (e) {
      if (cancelled || urls.length === 1) throw e;
      failed.push({ url: urls[i], error: e.message });
      emit({ kind: 'itemFailed', index: i + 1, count: urls.length, error: e.message.split('\n')[0] });
      emit({ kind: 'log', msg: `Skipped ${urls[i]}: ${e.message.split('\n')[0]}` });
    }
  }
  if (cancelled) throw new Error('Cancelled.');
  if (!saved.length && failed.length) throw new Error(`None of the ${failed.length} videos downloaded. First error: ${failed[0].error}`);
  return { files: saved, failed, dir: opts.outDir };
}

function cancel() {
  cancelled = true;
  if (current) { try { current.kill('SIGTERM'); } catch (e) { /* ignore */ } }
}

module.exports = { getStatus, installOrUpdate, download, cancel, ytPath, QUALITIES, findFfmpeg, ensureFfmpeg };
