// Minimal local dev server for PokerTrack Pro.
// - Serves static files from project root.
// - Accepts POST /api/upload-zip  (raw zip body, X-Filename header)
//     -> saves to data\<filename>
//     -> runs build-deep-from-zips.js then build-deep-analysis.js
//     -> responds JSON {ok, savedAs, rebuildMs, log}
//
// Start with: node server.js
// (Or via OPEN-POKER.bat which now uses this)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '8765', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.zip':  'application/zip',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

function safeFilename(raw) {
  if (!raw) return null;
  // Strip path components, keep basename only.
  let name = String(raw).split(/[\\/]/).pop().trim();
  // Remove anything not alnum, space, dot, dash, underscore, parens.
  name = name.replace(/[^A-Za-z0-9 .\-_()\[\]]/g, '_');
  if (!name) return null;
  if (!/\.zip$/i.test(name)) name += '.zip';
  return name;
}

function runScript(script) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Give the parser a big heap; build-deep-from-zips.js peaks ~1.5-2 GB
    // when re-parsing all 35 zips, which OOMs the default ~1.5 GB limit.
    const child = spawn(process.execPath, ['--max-old-space-size=8192', path.join(ROOT, script)], {
      cwd: ROOT,
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    child.on('close', (code) => {
      resolve({ script, code, ms: Date.now() - t0, log: out.slice(-4000) });
    });
    child.on('error', (err) => {
      resolve({ script, code: -1, ms: Date.now() - t0, log: 'spawn error: ' + err.message });
    });
  });
}

// Serialize rebuilds so concurrent uploads don't stomp each other.
// Track current job state for the polling endpoint.
let rebuildChain = Promise.resolve();
let jobSeq = 0;
const jobs = new Map(); // jobId -> { id, state, startedAt, finishedAt, results, savedAs }
const JOB_TTL_MS = 30 * 60 * 1000; // forget jobs older than 30 min

function gcJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.finishedAt && (now - j.finishedAt) > JOB_TTL_MS) jobs.delete(id);
  }
}

function queueRebuild(savedAs) {
  const id = ++jobSeq;
  const job = { id, state: 'queued', savedAs, startedAt: null, finishedAt: null, results: null };
  jobs.set(id, job);
  gcJobs();
  rebuildChain = rebuildChain.then(async () => {
    job.state = 'running';
    job.startedAt = Date.now();
    try {
      const r1 = await runScript('build-deep-from-zips.js');
      const r2 = await runScript('build-deep-analysis.js');
      // r3 bakes the fresh sessions.json into SEED_SESSIONS in index.html
      // so an empty-localStorage / incognito load shows the latest day too.
      const r3 = await runScript('rebuild-sessions.js');
      job.results = [r1, r2, r3];
      job.state = (r1.code === 0 && r2.code === 0 && r3.code === 0) ? 'done' : 'failed';
    } catch (err) {
      job.state = 'failed';
      job.results = [{ script: 'wrapper', code: -1, log: err.message }];
    }
    job.finishedAt = Date.now();
  }).catch(() => {});
  return id;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  // Strip query string
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // Resolve and ensure inside ROOT (basic traversal guard)
  const fsPath = path.normalize(path.join(ROOT, urlPath));
  if (!fsPath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.stat(fsPath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found: ' + urlPath);
    }
    const ext = path.extname(fsPath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    // Disable caching for the dashboard JSON so freshly rebuilt data shows immediately.
    const noCache = ext === '.json' || ext === '.html';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      'Cache-Control': noCache ? 'no-store' : 'public, max-age=300',
    });
    fs.createReadStream(fsPath).pipe(res);
  });
}

async function handleUploadZip(req, res) {
  const filename = safeFilename(req.headers['x-filename']);
  if (!filename) {
    return sendJson(res, 400, { ok: false, error: 'Missing or invalid X-Filename header' });
  }
  // Collect body
  const chunks = [];
  let total = 0;
  const MAX = 200 * 1024 * 1024; // 200 MB hard cap
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    total += chunk.length;
    if (total > MAX) {
      aborted = true;
      sendJson(res, 413, { ok: false, error: 'File too large (>200MB)' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', async () => {
    if (aborted) return;
    if (total === 0) return sendJson(res, 400, { ok: false, error: 'Empty body' });

    const buf = Buffer.concat(chunks, total);
    // Quick sanity: zip files start with "PK"
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B) {
      return sendJson(res, 400, { ok: false, error: 'Body does not look like a ZIP (missing PK signature)' });
    }

    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      // If a file with this exact name already exists with identical bytes, skip rebuild.
      const target = path.join(DATA_DIR, filename);
      let alreadyHave = false;
      if (fs.existsSync(target)) {
        try {
          const existing = fs.readFileSync(target);
          if (existing.length === buf.length && existing.equals(buf)) alreadyHave = true;
        } catch {}
      }
      if (!alreadyHave) {
        fs.writeFileSync(target, buf);
        console.log(`[upload] saved ${filename} (${buf.length} bytes)`);
      } else {
        console.log(`[upload] ${filename} already in data/, no rewrite needed`);
      }

      // Respond IMMEDIATELY with a job id; rebuild runs in background.
      // The browser polls /api/rebuild-status?job=ID until state==='done'.
      // This means a slow rebuild can never make the upload "hang".
      const jobId = queueRebuild(filename);
      sendJson(res, 202, {
        ok: true,
        accepted: true,
        jobId,
        savedAs: filename,
        bytes: buf.length,
        alreadyHad: alreadyHave,
        statusUrl: `/api/rebuild-status?job=${jobId}`,
      });
    } catch (err) {
      console.error('[upload] error', err);
      sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  req.on('error', (err) => {
    if (!aborted) sendJson(res, 500, { ok: false, error: err.message });
  });
}

function handleRebuildStatus(req, res) {
  const u = new URL(req.url, 'http://x');
  const id = parseInt(u.searchParams.get('job') || '0', 10);
  if (!id) {
    // No job id -> report queue depth and the most recent job
    const recent = [...jobs.values()].sort((a, b) => b.id - a.id)[0] || null;
    return sendJson(res, 200, { ok: true, recent, queueSize: jobs.size });
  }
  const job = jobs.get(id);
  if (!job) return sendJson(res, 404, { ok: false, error: 'job not found (may have expired)' });
  const now = Date.now();
  sendJson(res, 200, {
    ok: true,
    id: job.id,
    state: job.state,
    savedAs: job.savedAs,
    elapsedMs: job.startedAt ? (job.finishedAt || now) - job.startedAt : 0,
    queuedMs: job.startedAt ? null : (now - 0), // unknown queue start; just keep null when running
    results: job.state === 'done' || job.state === 'failed' ? job.results : null,
  });
}

const server = http.createServer((req, res) => {
  // CORS-friendly defaults (only matters if you ever open from another origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'POST' && req.url.split('?')[0] === '/api/upload-zip') {
    return handleUploadZip(req, res);
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/rebuild-status') {
    return handleRebuildStatus(req, res);
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/ping') {
    return sendJson(res, 200, { ok: true, server: 'pokertrack-pro', port: PORT });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end('Method Not Allowed');
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`PokerTrack Pro server: http://localhost:${PORT}`);
  console.log(`  Static root: ${ROOT}`);
  console.log(`  Upload endpoint: POST /api/upload-zip   (header X-Filename, raw zip body)`);
});
