'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { runJob } = require('./lib/capture');
const { writeOutputs } = require('./lib/output');
const yt = require('./lib/ytdlp');
const frames = require('./lib/frames');
const pitch = require('./lib/pitch');

app.setName('Board Daddy');
app.whenReady().then(() => {
  const icon = path.join(__dirname, 'build', 'icon.png');
  if (process.platform === 'darwin' && app.dock && require('fs').existsSync(icon)) app.dock.setIcon(icon);
});

let win;
const cancel = { flag: false };

function createWindow() {
  win = new BrowserWindow({
    width: 800, height: 960, minWidth: 660, minHeight: 700,
    title: 'Board Daddy', backgroundColor: '#15151a',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

ipcMain.handle('default-dir', () => app.getPath('downloads'));
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('reveal', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('cancel', () => { cancel.flag = true; });

ipcMain.handle('start', async (_e, opts) => {
  cancel.flag = false;
  const emit = (m) => { if (win && !win.isDestroyed()) win.webContents.send('progress', m); };
  try {
    if (!/^https?:\/\//i.test(String(opts.url || ''))) throw new Error('Please enter a full web address starting with http:// or https://');
    if (!opts.formats.pdf && !opts.formats.png && !opts.formats.text) throw new Error('Pick at least one export format.');
    const result = await runJob({ ...opts, wantText: !!opts.formats.text }, emit, () => cancel.flag);
    if (cancel.flag) return { ok: false, error: 'Cancelled.' };
    emit({ phase: 'save', msg: 'Writing files…' });
    const out = await writeOutputs({ outDir: opts.outDir, title: result.title, pages: result.pages, formats: opts.formats });
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---- Video downloader (yt-dlp) ----
const ytEmit = (m) => { if (win && !win.isDestroyed()) win.webContents.send('yt-progress', m); };
const frEmit = (m) => { if (win && !win.isDestroyed()) win.webContents.send('frames-progress', m); };
const errText = (e) => String((e && e.message) || e);
ipcMain.handle('default-video-dir', () => require('path').join(app.getPath('downloads'), 'Board Daddy Videos'));
ipcMain.handle('yt-status', () => yt.getStatus());
ipcMain.handle('yt-update', async () => {
  try { return { ok: true, ...(await yt.installOrUpdate(ytEmit)) }; } catch (e) { return { ok: false, error: errText(e) }; }
});
ipcMain.handle('yt-download', async (_e, opts) => {
  try { return { ok: true, ...(await yt.download(opts, ytEmit)) }; } catch (e) { return { ok: false, error: errText(e) }; }
});
ipcMain.handle('ff-install', async () => {
  try { return { ok: true, path: await yt.ensureFfmpeg((m) => { ytEmit(m); frEmit(m); }) }; } catch (e) { return { ok: false, error: errText(e) }; }
});
ipcMain.handle('yt-cancel', () => { yt.cancel(); });

// ---- Frames (scene detection + extraction) ----
ipcMain.handle('default-frames-dir', () => path.join(app.getPath('downloads'), 'Board Daddy Frames'));
ipcMain.handle('pick-video', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mxf', 'mpg', 'mpeg', 'mts', 'm2ts', 'wmv', 'flv', 'ts'] }, { name: 'All files', extensions: ['*'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('frames-start', async (_e, opts) => {
  try { return { ok: true, ...(await frames.extract(opts, frEmit)) }; } catch (e) { return { ok: false, error: errText(e) }; }
});
ipcMain.handle('frames-cancel', () => { frames.cancel(); });

// ---- Pitch media ----
const pEmit = (m) => { if (win && !win.isDestroyed()) win.webContents.send('pitch-progress', m); };
const pCancel = { flag: false };
ipcMain.handle('default-pitch-dir', () => path.join(app.getPath('downloads'), 'Board Daddy Pitch'));
ipcMain.handle('pitch-signin', (_e, url) => pitch.signIn(win, url));
ipcMain.handle('pitch-signout', () => pitch.signOut());
ipcMain.handle('pitch-status', async () => ({ signedIn: await pitch.isSignedIn() }));
ipcMain.handle('pitch-scan', async (_e, opts) => {
  pCancel.flag = false;
  try { return { ok: true, ...(await pitch.scan(opts, pEmit, () => pCancel.flag)) }; } catch (e) { return { ok: false, error: errText(e), code: e.code }; }
});
ipcMain.handle('pitch-download', async (_e, opts) => {
  try { return { ok: true, ...(await pitch.download(opts, pEmit)) }; } catch (e) { return { ok: false, error: errText(e) }; }
});
ipcMain.handle('pitch-cancel', () => { pCancel.flag = true; pitch.cancel(); });

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { app.quit(); });
