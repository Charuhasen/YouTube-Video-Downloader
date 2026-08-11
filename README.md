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

## Usage

1. Paste a YouTube or Instagram URL into the search bar and press Enter.
2. Pick a quality/format from the list that appears (video resolutions up to what's available, or MP3 audio).
3. Click download and wait for the progress to complete — the file will then download to your browser's default download location.

## Notes

- The server runs on port `3000` by default (hardcoded in `server.js`).
- Downloaded files are temporarily written to your OS temp directory while a download is in progress, then streamed to the browser and cleaned up afterward.
- Up to 5 downloads can run concurrently; additional requests will be rejected until a slot frees up.
