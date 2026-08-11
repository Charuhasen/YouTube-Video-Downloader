const $ = id => document.getElementById(id);

const form          = $('searchForm');
const urlInput      = $('urlInput');
const errorMsg      = $('errorMsg');
const result        = $('result');
const loadingCard   = $('loadingCard');
const videoCard     = $('videoCard');
const thumbnail     = $('thumbnail');
const videoTitle    = $('videoTitle');
const videoUploader = $('videoUploader');
const videoDuration = $('videoDuration');
const metaSep       = $('metaSep');
const sourceBadge   = $('sourceBadge');
const formatsCard   = $('formatsCard');
const formatList    = $('formatList');
const downloads     = $('downloads');
const dlTemplate    = $('downloadTemplate');

let currentUrl   = '';
let currentTitle = '';

// Hostnames we accept. The server (via yt-dlp) does the real work; this is just
// a quick client-side sanity check before hitting the API.
const SUPPORTED_HOSTS = [/(?:^|\.)(youtube\.com|youtu\.be)$/i, /(?:^|\.)instagram\.com$/i];

function isSupportedUrl(value) {
  let host;
  try { host = new URL(value).hostname; } catch { return false; }
  return SUPPORTED_HOSTS.some(re => re.test(host));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  if (!isSupportedUrl(url)) {
    setError('Please enter a valid YouTube or Instagram URL.');
    return;
  }

  currentUrl = url;
  clearError();
  showState('loading');

  try {
    const res  = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();

    if (!res.ok) { showState('hidden'); setError(data.error || 'Failed to fetch video info.'); return; }

    currentTitle    = data.title;
    thumbnail.src   = data.thumbnail || '';
    videoTitle.textContent    = data.title || '';
    videoUploader.textContent = data.uploader || '';
    videoDuration.textContent = data.duration  || '';
    metaSep.hidden = !data.uploader || !data.duration;

    sourceBadge.textContent = data.sourceName || '';
    sourceBadge.hidden = !data.sourceName;
    sourceBadge.dataset.source = data.source || '';

    renderFormats(data.formats || []);
    showState('info');
  } catch {
    showState('hidden');
    setError('Network error — is the server running?');
  }
});

function renderFormats(formats) {
  formatList.innerHTML = '';
  for (const fmt of formats) {
    const btn = document.createElement('button');
    btn.className = `fmt-btn${fmt.type === 'audio' ? ' audio' : ''}`;
    btn.innerHTML =
      `<span>${fmt.label}</span><span class="fmt-badge">${fmt.ext.toUpperCase()}</span>`;
    btn.addEventListener('click', () => download(fmt));
    formatList.appendChild(btn);
  }
}

// Each call spawns an independent download with its own card + EventSource,
// so any number can run concurrently.
function download(fmt) {
  // Snapshot the current video so a later search doesn't change this download.
  const url   = currentUrl;
  const title = currentTitle;

  const item   = dlTemplate.content.firstElementChild.cloneNode(true);
  const fill   = item.querySelector('.dl-fill');
  const pct    = item.querySelector('.dl-pct');
  const label  = item.querySelector('.dl-label');
  const speed  = item.querySelector('.dl-speed');
  const eta    = item.querySelector('.dl-eta');
  const cancel = item.querySelector('.dl-cancel');

  const shortTitle = title && title.length > 42 ? title.slice(0, 42) + '…' : title;
  label.textContent = `${fmt.label} · ${shortTitle || 'video'}`;
  downloads.prepend(item);

  // yt-dlp reports progress per stream: for merged formats it downloads the
  // video stream 0→100%, then the audio stream restarts at 0%. To keep the bar
  // moving forward, we map each stream into a shrinking slice of the remaining
  // space toward 100% and never let the displayed value go backward.
  const PHASE_BUDGET = 0.9; // each stream consumes 90% of the gap left to 100%
  let shown     = 0;        // displayed %, only ever increases (until 'done')
  let lastRaw   = 0;        // last raw % from yt-dlp, to detect a new stream
  let phaseBase = 0;        // displayed % at the start of the current stream
  let phaseCap  = 100 * PHASE_BUDGET; // ceiling this stream may climb toward

  const setPct = (p) => {
    shown = Math.min(100, Math.max(shown, p));
    fill.style.width = `${shown}%`;
    pct.textContent  = `${Math.round(shown)}%`;
  };

  const updateProgress = (raw) => {
    raw = Math.min(100, Math.max(0, raw));
    if (raw < lastRaw - 8) {            // big drop ⇒ a new stream started
      phaseBase = shown;
      phaseCap  = phaseBase + (100 - phaseBase) * PHASE_BUDGET;
    }
    lastRaw = raw;
    setPct(phaseBase + (raw / 100) * (phaseCap - phaseBase));
  };

  const params = new URLSearchParams({ url, format: fmt.selector, ext: fmt.ext, title });
  const es = new EventSource(`/api/download?${params}`);

  const finish = () => { es.close(); cancel.classList.add('hidden'); };

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'progress':
        updateProgress(msg.pct);
        speed.textContent = msg.speed || '';
        eta.textContent   = msg.eta ? `ETA ${msg.eta}` : '';
        break;
      case 'done':
        setPct(100);
        fill.classList.add('done');
        label.textContent = `Done · ${shortTitle || 'video'}`;
        speed.textContent = '';
        eta.textContent   = '';
        finish();
        triggerFileDownload(`/api/file/${msg.id}`, msg.filename);
        break;
      case 'error':
        fill.classList.add('error');
        label.textContent = `Error: ${msg.msg}`;
        finish();
        break;
    }
  };

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return; // already finished/cancelled
    fill.classList.add('error');
    label.textContent = 'Connection lost. Please try again.';
    finish();
  };

  cancel.addEventListener('click', () => {
    es.close(); // closing the stream signals the server to kill yt-dlp
    item.remove();
  });
}

function triggerFileDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function showState(state) {
  // Keep the result section mounted while any download is still listed,
  // so in-flight downloads stay visible even across a new search/error.
  result.hidden      = state === 'hidden' && downloads.childElementCount === 0;
  loadingCard.hidden = state !== 'loading';
  videoCard.hidden   = state === 'loading' || state === 'hidden';
  formatsCard.hidden = state === 'loading' || state === 'hidden';
}

function setError(msg) { errorMsg.textContent = msg; }
function clearError()  { errorMsg.textContent = ''; }
