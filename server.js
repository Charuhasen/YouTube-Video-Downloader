const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const YTDLP = 'yt-dlp';
const MAX_CONCURRENT = 5;

// Supported sources. Each entry matches a URL by hostname pattern. yt-dlp does
// the actual extraction, so adding a source here is mostly about recognising
// the URL and labelling it in the UI.
const SOURCES = [
  { id: 'youtube',   name: 'YouTube',   match: /(?:^|\.)(youtube\.com|youtu\.be)$/i },
  { id: 'instagram', name: 'Instagram', match: /(?:^|\.)instagram\.com$/i },
];

function detectSource(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  return SOURCES.find(s => s.match.test(host)) || null;
}

// Thumbnail images are fetched server-side to avoid the browser CORS/hotlink
// issues that come with saving a cross-origin image directly. Only proxy known
// CDN hosts (mirroring the SOURCES check above) so this can't be used as an
// open SSRF proxy for arbitrary URLs.
const THUMBNAIL_HOSTS = [
  /(?:^|\.)ytimg\.com$/i,
  /(?:^|\.)ggpht\.com$/i,
  /(?:^|\.)googleusercontent\.com$/i,
  /(?:^|\.)cdninstagram\.com$/i,
  /(?:^|\.)fbcdn\.net$/i,
];

function isAllowedThumbnailUrl(value) {
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return THUMBNAIL_HOSTS.some(re => re.test(u.hostname));
}

app.use(express.static(path.join(__dirname)));

const jobs = new Map();

// Remove any leftover temp files for a job id (partial or finished downloads).
function cleanupTemp(id) {
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(`ytdl_${id}`)) fs.unlink(path.join(os.tmpdir(), f), () => {});
    }
  } catch { /* tmpdir unreadable — nothing to clean */ }
}

function activeJobCount() {
  let n = 0;
  for (const job of jobs.values()) if (!job.done) n++;
  return n;
}

app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const source = detectSource(url);
  if (!source) {
    return res.status(400).json({
      error: `Unsupported URL. Supported sources: ${SOURCES.map(s => s.name).join(', ')}.`
    });
  }

  const proc = spawn(YTDLP, ['--dump-json', '--no-playlist', '--no-warnings', url]);
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

  proc.on('error', (err) => {
    const msg = err.code === 'ENOENT' ? 'yt-dlp is not installed or not on PATH' : `Failed to start yt-dlp: ${err.message}`;
    res.status(500).json({ error: msg });
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      const msg = stderr.includes('Private video') || stderr.includes('private') ? 'This content is private'
        : /login required|rate-limit reached|account|cookies/i.test(stderr) ? `${source.name} requires login to view this content`
        : stderr.includes('not available') ? 'Not available in your region'
        : stderr.includes('429') ? 'Too many requests — try again in a moment'
        : 'Could not fetch info. Check the URL and try again.';
      return res.status(400).json({ error: msg });
    }
    try {
      const info = JSON.parse(stdout);
      res.json({
        source: source.id,
        sourceName: source.name,
        title: info.title || info.description?.slice(0, 80) || `${source.name} video`,
        thumbnail: info.thumbnail,
        duration: formatDuration(info.duration),
        uploader: info.uploader || info.channel || info.uploader_id || '',
        formats: buildFormats(info.formats || [])
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

app.get('/api/download', (req, res) => {
  const { url, format, ext, title } = req.query;
  if (!url || !format) return res.status(400).json({ error: 'Missing url or format' });
  if (!detectSource(url)) return res.status(400).json({ error: 'Unsupported URL' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const id = crypto.randomBytes(8).toString('hex');
  const isAudio = ext === 'mp3';
  const outExt = isAudio ? 'mp3' : 'mp4';
  const tmpPath = path.join(os.tmpdir(), `ytdl_${id}.${outExt}`);
  const safeName = (title || 'video').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 100) || 'download';
  const filename = `${safeName}.${outExt}`;

  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (activeJobCount() >= MAX_CONCURRENT) {
    emit({ type: 'error', msg: `Too many downloads at once (max ${MAX_CONCURRENT}). Wait for one to finish.` });
    return res.end();
  }

  emit({ type: 'start' });

  const args = isAudio
    ? ['--no-playlist', '-f', format, '--extract-audio', '--audio-format', 'mp3',
       '--audio-quality', '0', '--newline', '-o', tmpPath, url]
    : ['--no-playlist', '-f', format, '--merge-output-format', 'mp4',
       '--newline', '-o', tmpPath, url];

  const proc = spawn(YTDLP, args);
  jobs.set(id, { proc, tmpPath, filename, done: false });

  const onLine = (line) => {
    const m = line.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*([\d.]+\s*\S+)\s+at\s+([\d.]+\s*\S+\/s)\s+ETA\s+(\S+)/);
    if (m) emit({ type: 'progress', pct: parseFloat(m[1]), size: m[2].trim(), speed: m[3].trim(), eta: m[4] });
  };

  proc.stdout.on('data', d => d.toString().split('\n').forEach(onLine));
  proc.stderr.on('data', d => d.toString().split('\n').forEach(onLine));

  proc.on('error', (err) => {
    jobs.delete(id);
    const msg = err.code === 'ENOENT' ? 'yt-dlp is not installed or not on PATH' : `Failed to start yt-dlp: ${err.message}`;
    emit({ type: 'error', msg });
    res.end();
  });

  proc.on('close', (code) => {
    if (code === 0) {
      let actualPath = tmpPath;
      if (!fs.existsSync(tmpPath)) {
        const files = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(`ytdl_${id}`));
        if (files.length) {
          actualPath = path.join(os.tmpdir(), files[0]);
        } else {
          emit({ type: 'error', msg: 'Output file not found after download' });
          return res.end();
        }
      }
      jobs.set(id, { ...jobs.get(id), tmpPath: actualPath, done: true });
      emit({ type: 'done', id, filename });
    } else {
      cleanupTemp(id);
      jobs.delete(id);
      emit({ type: 'error', msg: 'Download failed. The format may not be available.' });
    }
    res.end();
  });

  req.on('close', () => {
    const job = jobs.get(id);
    if (job && !job.done) {
      proc.kill('SIGTERM');
      cleanupTemp(id);
      jobs.delete(id);
    }
  });
});

app.get('/api/thumbnail', async (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  if (!isAllowedThumbnailUrl(url)) return res.status(400).json({ error: 'Unsupported thumbnail host' });

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).json({ error: 'Failed to fetch thumbnail' });

    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const safeName = (title || 'thumbnail').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 100) || 'thumbnail';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(500).json({ error: 'Failed to download thumbnail' });
  }
});

app.get('/api/file/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.done || !fs.existsSync(job.tmpPath)) {
    return res.status(404).send('File not found');
  }
  res.download(job.tmpPath, job.filename, () => {
    fs.unlink(job.tmpPath, () => {});
    jobs.delete(req.params.id);
  });
});

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function buildFormats(formats) {
  const levels = [
    { h: 2160, label: '4K Ultra HD' },
    { h: 1440, label: '1440p QHD' },
    { h: 1080, label: '1080p HD' },
    { h: 720,  label: '720p HD'  },
    { h: 480,  label: '480p'     },
    { h: 360,  label: '360p'     },
  ];

  const hasVideo = formats.some(f => f.vcodec && f.vcodec !== 'none');
  const videoHeights = formats
    .filter(f => f.vcodec && f.vcodec !== 'none' && f.height)
    .map(f => f.height);
  const maxH = videoHeights.length ? Math.max(...videoHeights) : 0;

  const result = [];
  for (const { h, label } of levels) {
    if (h <= maxH) {
      result.push({
        selector: `bestvideo[height<=${h}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${h}][vcodec^=avc1]+bestaudio/bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`,
        label,
        ext: 'mp4',
        type: 'video'
      });
    }
  }

  // Some sources (e.g. Instagram reels) expose video with no per-format height
  // metadata, or a single progressive stream. Offer a "best quality" option so
  // the user can still grab the video.
  if (hasVideo && result.length === 0) {
    result.push({ selector: 'best[ext=mp4]/best', label: 'Best Quality', ext: 'mp4', type: 'video' });
  }

  result.push({ selector: 'bestaudio/best', label: 'MP3 Audio', ext: 'mp3', type: 'audio' });
  return result;
}

app.listen(PORT, () => {
  console.log(`\n  YouTube Downloader  →  http://localhost:${PORT}\n`);
});
