# Board Daddy

A Mac app for VFX and production work, with four tools in one window:

| Tab | What it does |
|---|---|
| **Board Export** | Exports any online storyboard or treatment (Adobe Publish Online, Pitch, Google Slides, Canva, long scrolling pages) to full-resolution PDF, PNG and/or text. Handles password-protected decks. |
| **Video Downloader** | Downloads video from almost any site (YouTube, Vimeo, Instagram, TikTok and 1000+ more) using [yt-dlp](https://github.com/yt-dlp/yt-dlp), with a one-click **Update yt-dlp** button. |
| **Frames & Scenes** | Frame-exact frame extraction and scene detection from local video files, with a CSV shot list (timecodes and frame numbers). |
| **Pitch Media** | Pulls the original, full-resolution images and best-quality videos out of Pitch decks. |

Dark and light mode included.

## Install

**Download:** open this repo's **Actions** tab, choose **Build DMG**, click **Run workflow**, and when it
finishes (about 5 minutes) download the **Board-Daddy-dmg** artifact:

- `Board-Daddy-<version>-arm64.dmg` for Apple Silicon (M1/M2/M3/M4)
- `Board-Daddy-<version>-x64.dmg` for Intel Macs

Pushing a tag (`git tag v1.0.0 && git push --tags`) also attaches the DMGs to a GitHub Release.

**Or build it yourself** on a Mac (needs [Node.js](https://nodejs.org) 20+):

    npm install
    npm run dist             # DMGs land in ./dist
    npm start                # or run it without packaging

### First launch (the app is not notarized)

The app is ad-hoc signed but not notarized (that needs a paid Apple Developer ID).
After dragging it to Applications, open it once. macOS will block it the first time:

- **macOS 15 Sequoia and newer:** click Done, then go to **System Settings > Privacy & Security**, scroll down and click **Open Anyway** next to Board Daddy, then confirm.
- **macOS 14 and older:** right-click the app > **Open** > **Open**.

If macOS says the app is "damaged" (or you'd rather skip the above):

    xattr -cr "/Applications/Board Daddy.app"

## Board Export

Paste a link, pick what to export, hit **Export**. Each page is rendered in a hidden Chromium
window at its native size and captured directly (no screenshot size cap, optional 2× retina).
A live preview and filmstrip show each page as it is captured.

### Supported sites

| Mode | Works on | How |
|---|---|---|
| Adobe Publish Online | `indd.adobe.com/view/...` | Finds the per-page HTML files and renders each one at native size, GIF backgrounds frozen so pages are consistent |
| Page-by-page viewer | Pitch, Google Slides (published), Canva, Frame.io presentations, most slide viewers | Captures a slide, advances with Right arrow / Next button / Page Down / Space, stops when nothing changes or it loops |
| Long scrolling page | Notion/Squarespace/Webflow-style treatments | Scrolls to load lazy images, then splits the page into 16:9 sections |

"Auto-detect" picks one for you. If it guesses wrong, choose the mode manually.
Password-protected links work: type the password into the **Password** field (it is only typed into the page's own password box and is never saved or logged). Account sign-in pages (Google, Microsoft, etc.) are not supported.

### Notes

- Output goes to `<Save to>/<page title>/` as `<title>.pdf`, `pages/page-001.png…`, `<title>.txt`.
- Advanced: set width/height (default 1920x1080; Adobe auto-detects), max pages, and wait per page
  (raise it for slow or heavily animated sites).
- Source images embedded in a page are only as sharp as the originals; the app can't upscale them.

## Video Downloader

Paste one or more video links (YouTube, Vimeo, Instagram, TikTok and the other sites yt-dlp supports), pick a format, hit **Download**.

- Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). It is not bundled: on first use click **Install yt-dlp** (downloaded from the official GitHub release and checked against its SHA-256 sum). ffmpeg is fetched the same way if your Mac does not already have one.
- **Update yt-dlp** checks for the latest release and replaces the binary. Run it whenever a site stops working, since sites change often.
- Several links at once: one failing link doesn't stop the rest; failures are listed at the end.
- Formats: Best compatible (H.264 MP4 up to 1080p, plays in QuickTime/Premiere), Best quality (MKV), 720p MP4, MP3, M4A.
- Instagram, TikTok and age/login-restricted videos often need **Use browser login** (reads cookies from Safari/Chrome/Firefox/etc.). macOS may ask for Full Disk Access for Safari cookies.
- Files go to `Downloads/Board Daddy Videos` by default.
- Only download videos you own or have permission to save; the sites' terms still apply.

## Frames & Scenes

Pick a local video file and extract full-resolution frames.

- **One frame per shot (scene detection):** ffmpeg finds the cuts, then saves the first, middle or last frame of each shot. Use the sensitivity slider (lower finds more cuts) and "Ignore shots shorter than" to skip flashes.
- **Every N seconds** or **every N frames:** evenly spaced frames.
- Frame-exact: picks are made by frame number (frame 0 = first frame), and file names carry it (`0002_f000048.png` = shot 2, frame 48). NTSC rates (23.976, 29.97…) are handled exactly.
- MP4/MOV/MKV/MXF are read by seeking straight to each frame (fast). MPEG transport/program streams (.ts, .mts, .m2ts, .mpg…) can't be seeked reliably, so they're decoded once from the start instead (slower on long files, same result).
- Output is PNG (lossless) or JPG at the video's native size, in `<Save to>/<video name> - shots/` (or `- frames/`); a second run goes to `… - shots 2/` so runs never mix.
- The optional `shots.csv` has, per shot: start/end timecode, start/end frame (inclusive), frame count, start/end seconds, the extracted frame number and its file name. Timecode is non-drop-frame.
- Needs ffmpeg. The status bar at the top shows whether it's ready; if not, click **Install ffmpeg** (one-time ~30 MB download of a static build into the app's support folder). A Homebrew ffmpeg (`/opt/homebrew/bin` or `/usr/local/bin`) is used automatically if present. The same button appears on the Video Downloader tab.

## Pitch Media

Paste a Pitch link, click **Find media**, untick anything you don't want, then **Download selected**.

- **Originals, not previews.** Pitch shows images through a resizer (small AVIFs). Board Daddy asks for the untouched original upload instead, so you get the full-resolution PNG/JPG exactly as it was uploaded. The cards show the original size.
- **Videos** are Mux streams in Pitch. Board Daddy picks the highest-resolution rendition and saves it as an MP4 with ffmpeg (no re-encoding). ffmpeg installs itself on first use if needed.
- **Embedded YouTube/Vimeo/Loom videos** are listed separately with a **Send to Video Downloader** button.
- **Private decks and editor links** (`app.pitch.com/app/presentation/…`): click **Sign in to Pitch** once and sign in in the window that opens (it closes itself when you're in). The sign-in is kept in the app, separate from your browser; **Sign out** clears it. If Google sign-in is refused in that window, use "Continue with email and password". Public share links (`pitch.com/v/…`) work without signing in; password-protected ones use the Password field.
- Editor links are only viewed, never edited: Board Daddy steps through slides by clicking the slide list (videos only load once their slide is open), about 2–3 seconds per slide.
- Files go to `<Save to>/<deck title>/images/` and `/videos/` (a second download goes to `<deck title> 2`).

## Development

Everything needed to keep Board Daddy running and keep building it. Built with Electron 33 and Node 20+.
No servers, accounts, API keys or secrets are involved: the app runs entirely on the user's Mac and only
talks to the sites it exports from, GitHub (to fetch yt-dlp and ffmpeg) and the Electron download server
(installer DMG only).

### Quick start

```bash
git clone https://github.com/cnforge/board-daddy && cd board-daddy
npm install          # Electron, electron-builder, pdf-lib
npm start            # run the app from source
npm run test:all     # all five test suites (needs ffmpeg on PATH; see [Tests](#tests))
npm run dist         # on a Mac: dist/Board-Daddy-<version>-arm64.dmg and -x64.dmg
```

Prerequisites: Node.js 20 or newer, and `ffmpeg` on the PATH for the tests (`brew install ffmpeg`).
The app itself does not need a system ffmpeg: it downloads one for users who don't have it.

### Repository map

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
| `test/*.js` | Test suites (see [Tests](#tests)). `pitch-mock.js` is a local fake of Pitch. |
| `scripts/adhoc-sign.js` | electron-builder `afterPack` hook: ad-hoc code-signs the .app so it runs on Apple Silicon. |
| `installer/` | The small "installer" DMG (launcher script, Info.plist, build script). See [Small installer DMG](#small-installer-dmg). |
| `build/icon.png`, `build/icon.icns` | App icon. |
| `.github/workflows/build.yml` | GitHub Actions: builds the DMGs on a macOS runner. |

### Architecture

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

### How each tab works, and what tends to break

Everything that depends on **someone else's website** will eventually break when that site changes.
Those spots are marked ⚠️, with what to look at.

#### Board Export (`lib/capture.js`)

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

#### Video Downloader (`lib/ytdlp.js`)

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

#### Frames & Scenes (`lib/frames.js`)

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

#### Pitch Media (`lib/pitch.js`) ⚠️ most likely to need attention

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

### Making changes

* **New tab:** add markup in `index.html` (`<button class="tab" data-tab="x">` + `<main id="tab-x" hidden>`),
  a `renderer/x.js`, add the tab id to the switcher in `renderer/renderer.js`, and add IPC handlers
  (`main.js`) and bridge calls (`preload.js`). Copy `frames.js` as a template: it's the simplest complete tab.
* **New site for Board Export:** usually a selector in `CLICK_NEXT`, or a dedicated mode like `runAdobe`.
* IPC progress events can arrive *after* a job's result. Board Export and Pitch Media therefore ignore
  progress once a job has finished (`running` / `busy` flags). Do the same in new tabs, or progress bars
  can jump back after "Done".
* Run `npm run test:all` before every release.

### Tests

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

### Building and releasing

#### On a Mac (normal route)

```bash
npm version patch      # or minor/major: bumps package.json
npm run dist           # dist/Board-Daddy-<v>-arm64.dmg and -x64.dmg (about 100 MB each, self-contained)
```

`scripts/adhoc-sign.js` ad-hoc signs the app after packaging (`codesign --sign -`); without it the app
won't launch on Apple Silicon.

#### GitHub Actions

`.github/workflows/build.yml` runs on `macos-latest`. Trigger it from the **Actions** tab ("Run workflow"),
or push a tag `v1.2.3` to also attach the DMGs to a GitHub Release.

#### Small installer DMG

`npm run dist:installer`

Builds a 1 MB DMG whose app is a launcher script (`installer/launcher.sh`). On first launch it downloads
the matching Electron runtime (version taken from `node_modules/electron` at build time) into
`~/Library/Application Support/Board Daddy/`, then runs the app code shipped inside the DMG. It exists
because it can be built **without a Mac** (Linux: `hfsprogs` + mozilla/libdmg-hfsplus, built
automatically into `.cache/`). On a Mac it uses `hdiutil`.
Trade-offs: the menu bar shows "Electron" rather than "Board Daddy", and the first launch needs internet.
Prefer the normal route when a Mac is available.

#### Gatekeeper and notarization

The app is ad-hoc signed but **not notarized**, so users must allow it once (System Settings → Privacy &
Security → **Open Anyway** on macOS 15+, or right-click → Open on older versions; `xattr -cr` as a last
resort). To remove that step for good, you need an **Apple Developer account** (USD 99/year), a
"Developer ID Application" certificate, and electron-builder's `mac.notarize` settings with an
App Store Connect API key stored as GitHub secrets. That's about an hour of setup, and nothing in the
code has to change.

### Maintenance checklist

| How often | Task |
|---|---|
| When a site stops working | Video sites: have the user click **Update yt-dlp** first. Pitch/Adobe: see the ⚠️ notes under [How each tab works](#how-each-tab-works-and-what-tends-to-break). |
| Every few months | Bump Electron (`npm i -D electron@latest`), run `test:all`, rebuild. The installer DMG picks up the new version automatically. |
| Yearly | Revisit the pinned ffmpeg source (`FF_RELEASE` in `lib/ytdlp.js`). |
| Each release | `npm version …`, `npm run test:all`, `npm run dist`, test the DMG on one Apple Silicon and one Intel Mac if possible. |

### Known limitations and ideas

* Not yet verified end to end: running on a physical Mac, the real
  Pitch site inside the app (formats were verified in a browser, the app was tested against a mock),
  YouTube/Vimeo/Instagram/TikTok (only local test videos), and the `hdiutil` branch of the installer
  script. Do one manual pass of each tab on a Mac early on.
* Google sign-in can refuse embedded browsers; Pitch's "Continue with email and password" always works.
* Pitch Media: video tokens expire after about 24 hours, so download soon after **Find media** (just run it again if not).
* The Pitch tab's Password field (for password-protected share links) reuses Board Export's password-gate
  code, which is well tested, but it has not been tried on a real protected Pitch share link.
* Ideas: drag-and-drop a video file onto the Frames tab; a contact-sheet PDF from extracted frames; EDL
  export next to the CSV; parallel downloads in Pitch Media.
