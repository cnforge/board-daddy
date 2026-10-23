# Board Daddy

> **Developers:** start with [HANDOVER.md](HANDOVER.md): architecture, how each tab works, tests, releasing and maintenance.

Export any online storyboard or treatment to a full-resolution PDF, PNG images, and/or text.

Paste a link, pick what to export, hit **Export**. Each page is rendered in a hidden Chromium
window at its native size and captured directly (no screenshot size cap, optional 2x retina).

## Supported sites

| Mode | Works on | How |
|---|---|---|
| Adobe Publish Online | `indd.adobe.com/view/...` | Finds the per-page HTML files and renders each one at native size, GIF backgrounds frozen so pages are consistent |
| Page-by-page viewer | Pitch, Google Slides (published), Canva, Frame.io presentations, most slide viewers | Captures a slide, advances with Right arrow / Next button / Page Down / Space, stops when nothing changes or it loops |
| Long scrolling page | Notion/Squarespace/Webflow-style treatments | Scrolls to load lazy images, then splits the page into 16:9 sections |

"Auto-detect" picks one for you. If it guesses wrong, choose the mode manually.
Password-protected links work: type the password into the **Password** field (it is only typed into the page's own password box and is never saved or logged). Account sign-in pages (Google, Microsoft, etc.) are not supported.

## Video Downloader tab

Paste one or more video links (YouTube, Vimeo, Instagram, TikTok and the other sites yt-dlp supports), pick a format, hit **Download**.

- Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). It is not bundled: on first use click **Install yt-dlp** (downloaded from the official GitHub release and checked against its SHA-256 sum). ffmpeg is fetched the same way if your Mac does not already have one.
- **Update yt-dlp** checks for the latest release and replaces the binary. Run it whenever a site stops working, since sites change often.
- Several links at once: one failing link doesn't stop the rest; failures are listed at the end.
- Formats: Best compatible (H.264 MP4 up to 1080p, plays in QuickTime/Premiere), Best quality (MKV), 720p MP4, MP3, M4A.
- Instagram, TikTok and age/login-restricted videos often need **Use browser login** (reads cookies from Safari/Chrome/Firefox/etc.). macOS may ask for Full Disk Access for Safari cookies.
- Files go to `Downloads/Board Daddy Videos` by default.
- Only download videos you own or have permission to save; the sites' terms still apply.

## Frames & Scenes tab

Pick a local video file and extract full-resolution frames.

- **One frame per shot (scene detection):** ffmpeg finds the cuts, then saves the first, middle or last frame of each shot. Use the sensitivity slider (lower finds more cuts) and "Ignore shots shorter than" to skip flashes.
- **Every N seconds** or **every N frames:** evenly spaced frames.
- Frame-exact: picks are made by frame number (frame 0 = first frame), and file names carry it (`0002_f000048.png` = shot 2, frame 48). NTSC rates (23.976, 29.97…) are handled exactly.
- MP4/MOV/MKV/MXF are read by seeking straight to each frame (fast). MPEG transport/program streams (.ts, .mts, .m2ts, .mpg…) can't be seeked reliably, so they're decoded once from the start instead (slower on long files, same result).
- Output is PNG (lossless) or JPG at the video's native size, in `<Save to>/<video name> - shots/` (or `- frames/`); a second run goes to `… - shots 2/` so runs never mix.
- The optional `shots.csv` has, per shot: start/end timecode, start/end frame (inclusive), frame count, start/end seconds, the extracted frame number and its file name. Timecode is non-drop-frame.
- Needs ffmpeg. The status bar at the top shows whether it's ready; if not, click **Install ffmpeg** (one-time ~30 MB download of a static build into the app's support folder). A Homebrew ffmpeg (`/opt/homebrew/bin` or `/usr/local/bin`) is used automatically if present. The same button appears on the Video Downloader tab.

## Pitch Media tab

Paste a Pitch link, click **Find media**, untick anything you don't want, then **Download selected**.

- **Originals, not previews.** Pitch shows images through a resizer (small AVIFs). Board Daddy asks for the untouched original upload instead, so you get the full-resolution PNG/JPG exactly as it was uploaded. The cards show the original size.
- **Videos** are Mux streams in Pitch. Board Daddy picks the highest-resolution rendition and saves it as an MP4 with ffmpeg (no re-encoding). ffmpeg installs itself on first use if needed.
- **Embedded YouTube/Vimeo/Loom videos** are listed separately with a **Send to Video Downloader** button.
- **Private decks and editor links** (`app.pitch.com/app/presentation/…`): click **Sign in to Pitch** once and sign in in the window that opens (it closes itself when you're in). The sign-in is kept in the app, separate from your browser; **Sign out** clears it. If Google sign-in is refused in that window, use "Continue with email and password". Public share links (`pitch.com/v/…`) work without signing in; password-protected ones use the Password field.
- Editor links are only viewed, never edited: Board Daddy steps through slides by clicking the slide list (videos only load once their slide is open), about 2–3 seconds per slide.
- Files go to `<Save to>/<deck title>/images/` and `/videos/` (a second download goes to `<deck title> 2`).

## Get the DMG (GitHub Actions)

1. Create a GitHub repo and push this folder to it.
2. Open the repo's **Actions** tab, choose **Build DMG**, click **Run workflow**.
3. When it finishes (~5 min), download the **Board-Daddy-dmg** artifact. It contains:
   - `Board-Daddy-1.0.0-arm64.dmg` for Apple Silicon (M1/M2/M3/M4)
   - `Board-Daddy-1.0.0-x64.dmg` for Intel Macs

Tagging a release (`git tag v1.0.0 && git push --tags`) also attaches the DMGs to a GitHub Release.

## First launch (unsigned app)

The app is ad-hoc signed but not notarized (that needs a paid Apple Developer ID).
After dragging it to Applications, open it once. macOS will block it the first time:

- **macOS 15 Sequoia and newer:** click Done, then go to **System Settings > Privacy & Security**, scroll down and click **Open Anyway** next to Board Daddy, then confirm.
- **macOS 14 and older:** right-click the app > **Open** > **Open**.

If macOS says the app is "damaged" (or you'd rather skip the above):

    xattr -cr "/Applications/Board Daddy.app"

## Build locally instead

    npm install
    npm run dist             # full DMGs land in ./dist (on a Mac)
    npm run dist:installer   # small 1 MB installer DMG; also builds on Linux (see HANDOVER.md §7.3)
    npm start                # run without packaging

## Test

    npm run test:all     # everything below, in order
    npm run test:pitch   # Pitch Media against a local mock of Pitch (imgproxy originals, Mux HLS, slide list)
    npm run test:e2e     # launches the real app and clicks through all three tabs
    npm run test:frames  # synthetic video with known cuts: scene detection, extraction, CSV
    npm run test:yt      # installs real yt-dlp and downloads a local test video
    npm run test:smoke   # exercises paged + scroll capture and PDF/PNG/text export on local fixtures
    # on headless Linux: xvfb-run -a npx electron test/smoke.js --no-sandbox --disable-gpu

## Notes

- Output goes to `<Save to>/<page title>/` as `<title>.pdf`, `pages/page-001.png…`, `<title>.txt`.
- Advanced: set width/height (default 1920x1080; Adobe auto-detects), max pages, and wait per page
  (raise it for slow or heavily animated sites).
- Source images embedded in a page are only as sharp as the originals; the app can't upscale them.
