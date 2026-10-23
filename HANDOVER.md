# Board Daddy: developer handover

This is everything a new developer needs to keep Board Daddy running and keep building it.
For what the app does from a user's point of view, see [README.md](README.md).

**Status at handover (October 2026):** version 1.0.0, four tabs, five automated test suites, all passing.
Built with Electron 33 and Node 20+ (developed on Node 22). No servers, accounts, API keys or secrets
are involved: the app runs entirely on the user's Mac and only talks to the sites it exports from,
GitHub (to fetch yt-dlp and ffmpeg) and the Electron download server (installer DMG only).

---

## 1. Get going in 10 minutes

```bash
git clone <this repo> && cd board-daddy
npm install          # Electron, electron-builder, pdf-lib
npm start            # run the app from source
npm run test:all     # all five test suites (needs ffmpeg on PATH; see §6)
npm run dist         # on a Mac: dist/Board-Daddy-<version>-arm64.dmg and -x64.dmg
```

Prerequisites: Node.js 20 or newer, and `ffmpeg` on the PATH for the tests (`brew install ffmpeg`).
The app itself does not need a system ffmpeg: it downloads one for users who don't have it.

---

## 2. Repository map

| Path | What it is |
|---|---|
| `main.js` | Electron main process: creates the window and registers every IPC handler. Small, mostly wiring. |
| `preload.js` | The only bridge between UI and main process (`window.bd.*`). Every new IPC call must be added here. |
| `lib/capture.js` | **Board Export engine.** Offscreen Chromium windows, DevTools-protocol screenshots, slide advancing, password gates, Adobe Publish Online discovery. |
| `lib/output.js` | Writes PDF (pdf-lib), PNG pages and text for Board Export. |
| `lib/ytdlp.js` | **Video Downloader.** Installs/updates yt-dlp (checksum-verified) and ffmpeg, runs downloads. Also exports `findFfmpeg`/`ensureFfmpeg`, used by the other tabs. |
| `lib/frames.js` | **Frames & Scenes.** ffmpeg scene detection and frame-exact extraction, CSV shot list. |
| `lib/pitch.js` | **Pitch Media.** Sign-in window, deck walking, media collection, original-image and Mux-video download. |
| `renderer/index.html` | All four tabs' markup. Strict CSP: no inline scripts, images only as `data:` URLs. |
| `renderer/renderer.js` | Board Export tab, dark-mode switch, tab switching. |
| `renderer/video.js`, `frames.js`, `pitch.js` | One file per tab. |
| `renderer/style.css` | All styling; light/dark via CSS variables on `:root` / `[data-theme=light]`. |
| `test/*.js` | Test suites (see §6). `pitch-mock.js` is a local fake of Pitch. |
| `scripts/adhoc-sign.js` | electron-builder `afterPack` hook: ad-hoc code-signs the .app so it runs on Apple Silicon. |
| `installer/` | The small "installer" DMG (launcher script, Info.plist, build script). See §7.3. |
| `build/icon.png`, `build/icon.icns` | App icon. |
| `.github/workflows/build.yml` | GitHub Actions: builds the DMGs on a macOS runner. |

---

## 3. Architecture

```
renderer (UI, sandboxed)  ──window.bd.*──>  preload.js  ──ipcRenderer.invoke──>  main.js  ──>  lib/*.js
        ^                                                                              │
        └──────────── progress events: 'progress', 'yt-progress', 'frames-progress', 'pitch-progress'
```

* **Pattern for every feature:** the UI calls `window.bd.something(opts)` → `ipcMain.handle('something')`
  in `main.js` → a function in `lib/`. Long jobs stream progress back with `win.webContents.send(...)`
  and resolve with `{ ok: true, ... }` or `{ ok: false, error }`. Errors are user-facing sentences.
* **Security:** the main window uses `contextIsolation`, no Node in the renderer, and a strict CSP.
  Hidden capture windows are sandboxed, deny all permission requests and block pop-ups. Child
  processes (`yt-dlp`, `ffmpeg`) are spawned with argument arrays, never through a shell, and URLs are
  passed after `--`. Keep it that way.
* **Where things are stored on the user's Mac** (`~/Library/Application Support/Board Daddy/`):
  * `bin/yt-dlp`, `bin/ffmpeg`: downloaded tools.
  * `Partitions/pitch/`: the Pitch sign-in (cookies). **Sign out** in the app clears it.
  * `electron-33.x.x-arm64/`: the Electron runtime, only for the installer-DMG version.
  * The theme choice lives in the window's `localStorage`.
* **Environment variables** (used by the tests, handy for debugging):
  `BD_BIN_DIR` (where yt-dlp/ffmpeg live), `BD_IGNORE_SYSTEM_FFMPEG=1` (pretend no Homebrew ffmpeg),
  `BD_PITCH_PARTITION` (use a throwaway session instead of the saved Pitch sign-in).

### IPC reference

| Tab | Calls (`window.bd.*`) | Progress channel |
|---|---|---|
| Shared | `defaultDir`, `pickFolder`, `reveal` | |
| Board Export | `start(opts)`, `cancel` | `progress` |
| Video Downloader | `defaultVideoDir`, `ytStatus`, `ytUpdate`, `ytDownload`, `ytCancel`, `ffInstall` | `yt-progress` |
| Frames & Scenes | `defaultFramesDir`, `pickVideo`, `framesStart`, `framesCancel` | `frames-progress` |
| Pitch Media | `defaultPitchDir`, `pitchStatus`, `pitchSignIn`, `pitchSignOut`, `pitchScan`, `pitchDownload`, `pitchCancel` | `pitch-progress` |

---

## 4. How each tab works, and what tends to break

Everything that depends on **someone else's website** will eventually break when that site changes.
Those spots are marked ⚠️, with what to look at.

### 4.1 Board Export (`lib/capture.js`)

* Each page is rendered in an **offscreen** `BrowserWindow` at its native CSS size and captured with
  the DevTools protocol (`Page.captureScreenshot`), so output is full resolution with no stitching.
  Offscreen rendering matters: hidden normal windows stop painting and screenshots hang.
* `Emulation.setDeviceMetricsOverride` **crashes Electron if called before the first navigation**, so
  windows load `about:blank` first. Don't remove that.
* Modes: **paged** (press Right / click a "next" button / PageDown / Space until nothing changes or it
  loops back to slide 1), **scroll** (auto-scroll to load lazy images, then cut into 16:9 sections),
  **adobe** (see below), **auto** (scroll if the page is more than 3 screens tall).
* Each job uses its own in-memory session (`bd-job-<time>`), so logins/passwords carry between the
  windows of one job and are forgotten afterwards.
* **Password gates:** `findGate` looks in every frame and shadow DOM for a password box. With a password
  supplied it also accepts text boxes labelled password/passcode/PIN (Pitch uses one). It types with
  real keystrokes (`insertText` + Return), then falls back to setting the value and clicking submit.
  A lock-screen text check stops it exporting a "this deck is password protected" page as if it were
  the deck. The password is never logged (a test checks this).
* ⚠️ **Adobe Publish Online:** pages are found by watching network traffic for
  `…/package/<hash>/publication.html`, `publication-1.html`, … and probing until one 404s. If Adobe
  changes that layout, Board Export falls back to page-by-page capture.
* ⚠️ **Slide advancing** is heuristic (`CLICK_NEXT` selectors). For a site that won't advance, add its
  "next" button selector there.

### 4.2 Video Downloader (`lib/ytdlp.js`)

* **yt-dlp** ([github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp)) is not bundled. **Install /
  Update yt-dlp** reads the latest release tag from the `/releases/latest` redirect (the GitHub API is a
  fallback; it rate-limits), downloads `yt-dlp_macos`, **verifies it against `SHA2-256SUMS`**, test-runs
  it, then swaps it in. Users fix most "site stopped working" problems with the Update button, no app
  update needed.
* **ffmpeg** comes from the `eugeneware/ffmpeg-static` **b6.0** release (`ffmpeg-darwin-arm64.gz` /
  `-x64.gz`), or a Homebrew ffmpeg if one exists (`/opt/homebrew/bin`, `/usr/local/bin`). The arm64
  build is ad-hoc signed (required on Apple Silicon); the x64 build is unsigned, which Intel Macs allow.
  ⚠️ That release is pinned and getting old. If you move to another ffmpeg source, check the
  Apple Silicon binary is at least ad-hoc signed or it won't run.
* Downloads run `yt-dlp --ignore-config --newline --progress-template "download:BDP …"`. Progress lines
  start with `BDP`; final file paths are written with `--print-to-file after_move:filepath`.
* **Browser login** passes `--cookies-from-browser <browser>` (allow-list only). Safari cookies need
  Full Disk Access for the app; the error message says so.
* A batch keeps going past failed links and reports them at the end.
* Installs are single-flight: two tabs asking at once share one download.

### 4.3 Frames & Scenes (`lib/frames.js`)

* **Scene detection:** one ffmpeg pass, downscaled to 640 px for speed,
  `select='gt(scene,T)',showinfo`. Cut times are read from `showinfo`'s `pts_time` (already rebased to
  0, so **don't** subtract the file's start time; a test catches this). Cuts closer than "Ignore shots
  shorter than" are merged.
* **Everything works in frame numbers** (frame 0 = first frame), which is what makes it frame-exact:
  * MP4/MOV/MKV/MXF: one ffmpeg call per frame with input seeking at `frame/fps − ¼ frame`
    (accurate seek returns the first frame at or after the time, so seeking slightly early never skips it).
  * MPEG transport/program streams (`.ts .mts .m2ts .mpg …`) can't be seeked reliably, so one decode
    pass with `select=eq(n\,A)+eq(n\,B)…` is used instead. If a seek ever fails, it switches to this.
* ffmpeg prints NTSC rates rounded (23.98), which drifts about 9 frames per hour; `exactFps()` maps them
  to 24000/1001 etc. Timecode in the CSV is non-drop-frame.
* Every run gets its own folder (`… - shots`, `… - shots 2`), and there's a 5,000-frame safety cap.

### 4.4 Pitch Media (`lib/pitch.js`) ⚠️ most likely to need attention

Pitch has no public export API, so this tab relies on how Pitch's web app works internally. All of this
was verified on a real deck in October 2026:

| What | How Pitch does it | What the app does |
|---|---|---|
| Images | Shown through imgproxy: `https://[cdn2.]imgproxy.services.pitch.com/_/w:1336/h:748/…/format:avif/plain/pitch-assets-<bucket>/<uuid>`. The editor displays them as `blob:` URLs. | Takes the part after `/plain/` and requests `https://imgproxy.services.pitch.com/_/raw:1/plain/<that>`. **`raw:1` returns the untouched original upload**, byte-identical to the stored file (for example an 11.7 MB, 2944×1648 PNG instead of a 73 KB AVIF). |
| Videos | Mux HLS: `https://stream.mux.com/<playbackId>.m3u8?token=<signed JWT, about 24 h>`, thumbnails on `image.mux.com`. No MP4 renditions. The best rendition is **not listed first**. Variant playlists and chunks need no cookies. | Reads the master playlist, picks the highest resolution, and remuxes it to MP4 with `ffmpeg -c copy`. If audio is a separate track, it gives ffmpeg the master playlist instead. |
| Slides | Editor links (`app.pitch.com/app/presentation/…`) have a slide list of `[data-test-id="editor-sidebar-slides-item"]`. Videos only load once their slide is open. | Clicks each slide item (view only; **never sends keys in the editor**, since arrow keys would nudge selected objects) and waits about 2.5 s. Share links (`pitch.com/v/…`) are stepped through like Board Export. |
| Sign-in | Cookie `auth0.<id>.is.authenticated=true` on `app.pitch.com`. | `isSignedIn()` checks that cookie in the saved partition `persist:pitch`. The sign-in window shares that partition. The user agent has "Electron" removed so Google sign-in is less likely to refuse. |

Media is collected from the network (`session.webRequest.onCompleted`) and from the DOM (`SCAN_DOM`).
On Pitch, everything that isn't imgproxy, Mux or an embed (YouTube/Vimeo/Loom…) is ignored as app chrome.
Originals under 100 px are skipped as icons.

**If the Pitch tab stops finding things**, open the deck in Chrome, open DevTools, and run:

```js
performance.setResourceTimingBufferSize(20000);
// click through a few slides, then:
[...new Set(performance.getEntriesByType('resource').map(r => new URL(r.name).host + ' ' + r.initiatorType))]
```

That shows which hosts now serve the images and videos. Then update `pitchSrc`, `muxId`/`muxThumbId`,
the slide-list selector in `walkEditor`, or the cookie test in `isSignedIn`. `test/pitch-mock.js`
mirrors these formats, so update it too, and `npm run test:pitch` keeps you honest.
Note: the browser's resource list holds only 250 entries by default, hence the first line.

---

## 5. Making changes

* **New tab:** add markup in `index.html` (`<button class="tab" data-tab="x">` + `<main id="tab-x" hidden>`),
  a `renderer/x.js`, add the tab id to the switcher in `renderer/renderer.js`, and add IPC handlers
  (`main.js`) and bridge calls (`preload.js`). Copy `frames.js` as a template: it's the simplest complete tab.
* **New site for Board Export:** usually a selector in `CLICK_NEXT`, or a dedicated mode like `runAdobe`.
* IPC progress events can arrive *after* a job's result. Board Export and Pitch Media therefore ignore
  progress once a job has finished (`running` / `busy` flags). Do the same in new tabs, or progress bars
  can jump back after "Done".
* Run `npm run test:all` before every release.

---

## 6. Tests

| Command | Covers |
|---|---|
| `npm run test:smoke` | Board Export on local fixtures: paged/scroll/auto, PDF/PNG/text, 2× output, five kinds of password gate (iframe, late-appearing, keystroke-only, Pitch-style passcode box, wrong/missing password). |
| `npm run test:yt` | Real yt-dlp install from GitHub with checksum, up-to-date check, update of an outdated binary, MP4 and MP3 downloads from a local server, batch with a failing link, error hints. **Needs internet.** |
| `npm run test:frames` | ffmpeg install path, scene detection on a video with known cuts, **pixel-exact** frame picks against reference decodes, CSV, TS files, 23.976 fps. **Needs internet** (downloads ffmpeg). |
| `npm run test:pitch` | Pitch Media against `test/pitch-mock.js`: a local HTTPS server answering for the real Pitch/Mux hostnames through a CONNECT proxy (self-signed cert accepted only in that test session). Checks originals are byte-identical, 1080p rendition chosen, sign-in detection, login wall. |
| `npm run test:e2e` | Launches the **real app** and clicks through all four tabs like a user. |

* On headless Linux, prefix with `xvfb-run -a` and add `--no-sandbox --disable-gpu`, e.g.
  `xvfb-run -a npx electron test/e2e.js --no-sandbox --disable-gpu`.
* Linux quirk: the Linux `ffmpeg-static` build segfaulted on MPEG-TS input in the sandbox these tests
  were developed in, so the tests switch to the system ffmpeg for `.ts`/HLS steps. Not an issue on Macs.
* Each suite prints `PASS`/`FAIL` lines and ends with `ALL PASSED` (exit code 0) or `N FAILED`.

---

## 7. Building and releasing

### 7.1 Normal route: on a Mac

```bash
npm version patch      # or minor/major: bumps package.json
npm run dist           # dist/Board-Daddy-<v>-arm64.dmg and -x64.dmg (about 100 MB each, self-contained)
```

`scripts/adhoc-sign.js` ad-hoc signs the app after packaging (`codesign --sign -`); without it the app
won't launch on Apple Silicon.

### 7.2 GitHub Actions

`.github/workflows/build.yml` runs on `macos-latest`. Trigger it from the **Actions** tab ("Run workflow"),
or push a tag `v1.2.3` to also attach the DMGs to a GitHub Release.

### 7.3 Small installer DMG (`npm run dist:installer`)

Builds a 1 MB DMG whose app is a launcher script (`installer/launcher.sh`). On first launch it downloads
the matching Electron runtime (version taken from `node_modules/electron` at build time) into
`~/Library/Application Support/Board Daddy/`, then runs the app code shipped inside the DMG. It exists
because it can be built **without a Mac** (Linux: `hfsprogs` + mozilla/libdmg-hfsplus, built
automatically into `.cache/`). On a Mac it uses `hdiutil`.
Trade-offs: the menu bar shows "Electron" rather than "Board Daddy", and the first launch needs internet.
Prefer 7.1 when a Mac is available.

### 7.4 Gatekeeper and notarization

The app is ad-hoc signed but **not notarized**, so users must allow it once (System Settings → Privacy &
Security → **Open Anyway** on macOS 15+, or right-click → Open on older versions; `xattr -cr` as a last
resort). To remove that step for good, the company needs an **Apple Developer account** (USD 99/year), a
"Developer ID Application" certificate, and electron-builder's `mac.notarize` settings with an
App Store Connect API key stored as GitHub secrets. That's about an hour of setup, and nothing in the
code has to change.

---

## 8. Maintenance checklist

| How often | Task |
|---|---|
| When a site stops working | Video sites: have the user click **Update yt-dlp** first. Pitch/Adobe: see the ⚠️ notes in §4. |
| Every few months | Bump Electron (`npm i -D electron@latest`), run `test:all`, rebuild. The installer DMG picks up the new version automatically. |
| Yearly | Revisit the pinned ffmpeg source (`FF_RELEASE` in `lib/ytdlp.js`). |
| Each release | `npm version …`, `npm run test:all`, `npm run dist`, test the DMG on one Apple Silicon and one Intel Mac if possible. |

## 9. Known limitations and ideas

* Not yet verified on real hardware/sites from the dev environment: running on a physical Mac, the real
  Pitch site inside the app (formats were verified in a browser, the app was tested against a mock),
  YouTube/Vimeo/Instagram/TikTok (only local test videos), and the `hdiutil` branch of the installer
  script. Do one manual pass of each tab on a Mac early on.
* Google sign-in can refuse embedded browsers; Pitch's "Continue with email and password" always works.
* Pitch Media: video tokens expire after about 24 hours, so download soon after **Find media** (just run it again if not).
* The Pitch tab's Password field (for password-protected share links) reuses Board Export's password-gate
  code, which is well tested, but it has not been tried on a real protected Pitch share link.
* Ideas: drag-and-drop a video file onto the Frames tab; a contact-sheet PDF from extracted frames; EDL
  export next to the CSV; parallel downloads in Pitch Media.

## 10. Ownership to-dos for the company

1. Create the GitHub repo under the company account and push this repo (`git remote add origin … && git push -u origin main`).
2. Update `package.json`: `author`, `license` (currently `UNLICENSED`, which means proprietary, all rights
   reserved), and `build.appId` if the company uses its own reverse-DNS ids (`com.<company>.boarddaddy`).
   Changing `appId`/`productName` changes where settings are stored, so users would have to install yt-dlp/ffmpeg again and sign in to Pitch again.
3. Optional: Apple Developer account for notarization (§7.4).
4. There are no credentials, tokens or personal accounts in the code or its config to hand over or rotate.
