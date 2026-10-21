import express from 'express';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const COOKIES = process.env.COOKIES_FILE || '/data/cookies.txt'; // Netscape cookies.txt (YouTube login) - optional
const PROXY = process.env.PROXY_URL || '';                       // residential/ISP proxy - optional
const POT_URL = process.env.POT_PROVIDER_URL || '';              // bgutil PO-token server - optional
const MAX_JOBS = Number(process.env.MAX_JOBS || 3);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}
async function checkUrl(u) {
  let url;
  try { url = new URL(String(u).trim()); } catch { throw new Error('Invalid link'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Only http/https links are allowed');
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw new Error('This address is not allowed');
  return url.href;
}
function baseArgs() {
  const a = ['--no-playlist', '--no-warnings', '--js-runtimes', 'node',
    '--retries', '5', '--fragment-retries', '5', '--socket-timeout', '20',
    '--geo-bypass', '--concurrent-fragments', '4'];
  if (existsSync(COOKIES)) a.push('--cookies', COOKIES);
  if (PROXY) a.push('--proxy', PROXY);
  if (POT_URL) a.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_URL}`);
  return a;
}
const lastError = (s = '') => {
  const l = s.split('\n').filter(x => /ERROR/.test(x)).pop() || s.trim().split('\n').pop() || 'Unknown error';
  return l.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 300);
};
const run = args => new Promise((res, rej) =>
  execFile('yt-dlp', args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
    (e, so, se) => e ? rej(new Error(lastError(se) || e.message)) : res(so)));

/* ---------- info ---------- */
app.get('/api/info', async (req, res) => {
  try {
    const url = await checkUrl(req.query.url);
    const j = JSON.parse(await run([...baseArgs(), '-J', '--', url]));
    const f = j.formats || [];
    const vids = f.filter(x => x.vcodec && x.vcodec !== 'none' && x.height);
    const aud = f.filter(x => x.vcodec === 'none' && x.acodec && x.acodec !== 'none')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
    const heights = [...new Set(vids.map(x => x.height))].sort((a, b) => b - a);
    const sizes = {};
    for (const h of heights) {
      const v = vids.filter(x => x.height === h).sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
      const s = (v.filesize || v.filesize_approx || 0) +
        (v.acodec && v.acodec !== 'none' ? 0 : (aud?.filesize || aud?.filesize_approx || 0));
      if (s) sizes[h] = s;
    }
    res.json({
      url, title: j.title, uploader: j.uploader || j.channel || '', duration: j.duration || 0,
      views: j.view_count || 0, thumbnail: j.thumbnail || '', site: j.extractor_key || j.extractor || '',
      heights, sizes, hasVideo: heights.length > 0
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---------- jobs ---------- */
const jobs = new Map();
const emit = (job) => {
  const d = JSON.stringify({ status: job.status, progress: job.progress, speed: job.speed, eta: job.eta, name: job.name, error: job.error });
  for (const r of job.listeners) r.write(`data: ${d}\n\n`);
};

app.post('/api/jobs', async (req, res) => {
  try {
    if ([...jobs.values()].filter(j => j.status === 'running').length >= MAX_JOBS)
      return res.status(429).json({ error: 'Server is busy, try again in a moment' });
    const url = await checkUrl(req.body.url);
    const mode = req.body.mode === 'audio' ? 'audio' : 'video';
    const h = Number(req.body.height) || 0;
    const fmt = String(req.body.fmt || (mode === 'audio' ? 'mp3' : 'mp4'));
    const id = crypto.randomUUID();
    const dir = await mkdtemp(path.join(tmpdir(), 'err-'));
    const job = { id, dir, status: 'running', progress: 0, speed: '', eta: '', listeners: new Set(), created: Date.now() };
    jobs.set(id, job);

    const args = [...baseArgs(), '--newline', '--windows-filenames',
      '--progress-template', 'download:P|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '-o', path.join(dir, '%(title).100B.%(ext)s')];
    if (mode === 'audio') {
      const af = ['mp3', 'm4a', 'opus', 'wav'].includes(fmt) ? fmt : 'mp3';
      args.push('-f', 'ba/b', '-x', '--audio-format', af, '--audio-quality', '0');
    } else {
      const c = h ? `[height<=${h}]` : '';
      const webm = fmt === 'webm';
      args.push('-f', webm
        ? `bv*${c}[ext=webm]+ba[ext=webm]/bv*${c}+ba/b${c}/b`
        : `bv*${c}[ext=mp4]+ba[ext=m4a]/bv*${c}+ba/b${c}/b`,
        '--merge-output-format', webm ? 'webm' : 'mp4');
    }
    args.push('--', url);

    const p = spawn('yt-dlp', args);
    let err = '', buf = '';
    p.stdout.on('data', d => {
      buf += d; const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('P|')) continue;
        const [, pc, sp, eta] = l.split('|');
        job.progress = Math.min(99, parseFloat(pc) || job.progress);
        job.speed = (sp || '').trim(); job.eta = (eta || '').trim(); emit(job);
      }
    });
    p.stderr.on('data', d => { err += d; });
    p.on('close', async code => {
      if (code === 0) {
        const files = (await readdir(dir)).filter(n => !/\.(part|ytdl|temp)$/i.test(n));
        let best = null, size = -1;
        for (const n of files) { const s = (await stat(path.join(dir, n))).size; if (s > size) { best = n; size = s; } }
        if (best) { job.file = path.join(dir, best); job.name = best; job.status = 'done'; job.progress = 100; }
        else { job.status = 'error'; job.error = 'No file was produced'; }
      } else { job.status = 'error'; job.error = lastError(err); }
      emit(job);
      for (const r of job.listeners) r.end();
    });
    res.json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  job.listeners.add(res);
  req.on('close', () => job.listeners.delete(res));
  emit(job);
  if (job.status !== 'running') res.end();
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(404).send('Not ready');
  if (req.query.inline) return res.sendFile(job.file);          // supports Range -> seekable playback
  res.download(job.file, job.name);
});

setInterval(async () => {
  for (const [id, j] of jobs) if (Date.now() - j.created > 30 * 60 * 1000 && j.status !== 'running') {
    jobs.delete(id); rm(j.dir, { recursive: true, force: true }).catch(() => {});
  }
}, 5 * 60 * 1000);

/* ---------- keep yt-dlp fresh (YouTube changes constantly) ---------- */
const update = () => execFile('yt-dlp', ['-U'], (e, so) => console.log('[yt-dlp update]', (so || e?.message || '').trim().split('\n').pop()));
update(); setInterval(update, 6 * 60 * 60 * 1000);

app.listen(PORT, () => console.log(`ERROR Video Downloader running on :${PORT}`));
