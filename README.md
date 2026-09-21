# Media Downloader

A simple web app for downloading videos (or extracting MP3 audio) from YouTube and Instagram. It has a Node/Express backend that shells out to [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) for the actual extraction/download, and a static HTML/CSS/JS frontend for pasting a link, choosing a quality, and downloading the result.

## Prerequisites

- **[Node.js](https://nodejs.org/)** (v18 or later recommended)
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Installation)** — must be installed and available on your system `PATH` (the server calls it as the `yt-dlp` command)
- **[ffmpeg](https://ffmpeg.org/download.html)** — required by yt-dlp to merge separate video/audio streams into MP4 and to extract MP3 audio; must also be on your `PATH`

To verify both are installed correctly, run:

```powershell
yt-dlp --version
ffmpeg -version
```

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Start the server:

   ```powershell
   npm start
   ```

3. Open your browser to:

   ```
   http://localhost:3000
   ```

## Signed-in downloads

Some videos are never served to anonymous viewers. Age-restricted ones are the
common case: every yt-dlp player client answers *"Sign in to confirm your age"*,
and no combination of options gets around it. The same goes for private,
members-only, and purchased videos, and for Instagram posts behind a login.

The fix is to give yt-dlp cookies from an account that can already watch the
video. Pick whichever is easier:

**Read them from your browser** — set `YTDLP_COOKIES_FROM_BROWSER` to the
browser you're signed into YouTube with, then start the server:

```powershell
$env:YTDLP_COOKIES_FROM_BROWSER = "firefox"
npm start
```

Supported values are `brave`, `chrome`, `chromium`, `edge`, `firefox`, `opera`,
`safari`, `vivaldi`, and `whale`; yt-dlp also accepts a fuller
`browser[+keyring][:profile]` form. Close the browser first — it locks its
cookie database while running. On Windows, Chrome and Edge encrypt cookies in a
way yt-dlp often cannot read; if you hit that, use Firefox or the file method
below.

**Export a cookie file** — use a "cookies.txt" browser extension to export your
YouTube cookies in Netscape format, and either save it as `cookies.txt` next to
`server.js` (picked up automatically, no restart needed) or point
`YTDLP_COOKIES` at it:

```powershell
$env:YTDLP_COOKIES = "C:\path\to\cookies.txt"
npm start
```

The server prints which cookie source it's using at startup. `cookies.txt` is
gitignored, and for good reason — it contains live session tokens for your
account, so treat it like a password and don't commit or share it. YouTube
invalidates the cookies when you sign out of that browser session, so export
from a private/incognito window you close without signing out if you want them
to last.

## Usage

1. Paste a YouTube or Instagram URL into the search bar and press Enter.
2. Pick a quality/format from the list that appears (video resolutions up to what's available, or MP3 audio).
3. Click download and wait for the progress to complete — the file will then download to your browser's default download location.

## Notes

- The server runs on port `3000` by default (hardcoded in `server.js`).
- Downloaded files are temporarily written to your OS temp directory while a download is in progress, then streamed to the browser and cleaned up afterward.
- Up to 5 downloads can run concurrently; additional requests will be rejected until a slot frees up.
- YouTube changes its extraction defences often. If downloads start failing across the board, update yt-dlp first (`yt-dlp -U`) — that fixes most breakage without any change here.
