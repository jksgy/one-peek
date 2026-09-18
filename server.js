/*
 * 一眼即焚 OnePeek —— 阅后即焚式图片/视频一次性分享服务
 * 零依赖，仅使用 Node.js 内置模块
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3456);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const META_FILE = path.join(DATA_DIR, 'meta.json');

const MAX_SIZE = 300 * 1024 * 1024;          // 300MB
const MAX_HOURS = 24 * 7;                    // 最长保留 7 天
const KEEP_AFTER_VIEW_MS = 60 * 60 * 1000;   // 被查看后文件保留 1 小时再物理删除（期间无法再访问）

fs.mkdirSync(FILES_DIR, { recursive: true });

let meta = {};
try {
  meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  if (!meta || typeof meta !== 'object') meta = {};
} catch (e) {
  meta = {};
}

function saveMeta() {
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  } catch (e) {
    console.error('保存元数据失败:', e.message);
  }
}

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska'
};

function guessMime(ext) {
  return MIME_MAP[String(ext || '').toLowerCase()] || null;
}

function sanitizeName(name) {
  name = String(name || 'file').split(/[\\/]/).pop();
  name = name.replace(/[\r\n\t"']/g, '').trim().slice(0, 120);
  return name || 'file';
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBodySafe() { /* 占位：上传用流式处理，见 handleUpload */ }

/* ---------- 静态文件 ---------- */
function serveStatic(res, filePath) {
  const full = path.join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'Content-Type': guessMime(path.extname(full)) || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ---------- 上传 ---------- */
function handleUpload(req, res, u) {
  const name = sanitizeName(decodeURIComponent(u.searchParams.get('name') || 'file'));
  const type = (u.searchParams.get('type') || '').slice(0, 100);
  let hours = parseFloat(u.searchParams.get('hours') || '24');
  if (!isFinite(hours) || hours <= 0) hours = 24;
  hours = Math.min(hours, MAX_HOURS);

  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > MAX_SIZE) {
    return sendJSON(res, 413, { error: '文件过大，最大支持 300MB' });
  }

  const id = crypto.randomBytes(12).toString('hex');
  const ext = path.extname(name).toLowerCase();
  const fname = id + ext;
  const fpath = path.join(FILES_DIR, fname);
  const ws = fs.createWriteStream(fpath);

  let size = 0;
  let over = false;
  let aborted = false;

  const cleanup = () => {
    try { ws.destroy(); } catch (e) {}
    try { fs.unlinkSync(fpath); } catch (e) {}
  };

  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_SIZE) {
      over = true;
      aborted = true;
      cleanup();
      return sendJSON(res, 413, { error: '文件过大，最大支持 300MB' });
    }
    ws.write(chunk);
  });

  req.on('end', () => {
    if (aborted) return;
    ws.end(() => {
      const token = crypto.randomBytes(16).toString('hex');
      const manageKey = crypto.randomBytes(12).toString('hex');
      meta[token] = {
        name,
        mime: type || guessMime(ext) || 'application/octet-stream',
        size,
        file: fname,
        created: Date.now(),
        expires: Date.now() + hours * 3600 * 1000,
        consumed: null,
        deletedAt: null,
        manageKey
      };
      saveMeta();
      sendJSON(res, 200, {
        token,
        manageKey,
        path: '/v/' + token,
        managePath: '/s/' + token
      });
    });
  });

  req.on('error', () => {
    aborted = true;
    cleanup();
    try { sendJSON(res, 500, { error: '上传中断' }); } catch (e) {}
  });
}

/* ---------- 一次性媒体访问 ---------- */
function handleMedia(req, res, token) {
  const m = meta[token];
  const gone = (reason) => sendJSON(res, 410, { error: 'gone', reason });

  if (!m) return sendJSON(res, 404, { error: 'not_found' });
  if (m.deletedAt) return gone('deleted');
  if (Date.now() > m.expires) return gone('expired');
  if (m.consumed) return gone('viewed');

  // 标记已消费 —— 从此刻起任何再次请求都会被拒绝
  m.consumed = Date.now();
  saveMeta();

  const fpath = path.join(FILES_DIR, m.file);
  fs.stat(fpath, (err, st) => {
    if (err || !st.isFile()) return gone('missing');
    res.writeHead(200, {
      'Content-Type': m.mime,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(m.name)
    });
    const rs = fs.createReadStream(fpath);
    rs.pipe(res);
    rs.on('error', () => res.end());
  });
}

/* ---------- 管理接口 ---------- */
function handleStatus(req, res, token, u) {
  const m = meta[token];
  if (!m) return sendJSON(res, 404, { error: 'not_found' });
  const k = u.searchParams.get('k') || '';
  if (k !== m.manageKey) return sendJSON(res, 403, { error: 'forbidden' });
  sendJSON(res, 200, {
    name: m.name,
    size: m.size,
    mime: m.mime,
    created: m.created,
    expires: m.expires,
    consumed: m.consumed,
    deleted: !!m.deletedAt
  });
}

function handleDelete(req, res, token, u) {
  const m = meta[token];
  if (!m) return sendJSON(res, 404, { error: 'not_found' });
  const k = u.searchParams.get('k') || '';
  if (k !== m.manageKey) return sendJSON(res, 403, { error: 'forbidden' });
  try { fs.unlinkSync(path.join(FILES_DIR, m.file)); } catch (e) {}
  m.deletedAt = Date.now();
  saveMeta();
  sendJSON(res, 200, { ok: true });
}

/* ---------- 局域网地址 ---------- */
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

/* ---------- 过期 / 焚毁清理 ---------- */
function cleanup() {
  const now = Date.now();
  let dirty = false;
  for (const token of Object.keys(meta)) {
    const m = meta[token];
    const fpath = path.join(FILES_DIR, m.file);
    const fileExists = fs.existsSync(fpath);

    if (!m.deletedAt && !m.consumed && now > m.expires) {
      // 无人查看但已过期 —— 焚毁
      try { fs.unlinkSync(fpath); } catch (e) {}
      m.deletedAt = now;
      dirty = true;
    } else if (m.consumed && fileExists && now - m.consumed > KEEP_AFTER_VIEW_MS) {
      // 已被查看过 —— 物理删除文件，元数据保留以便展示"已焚毁"
      try { fs.unlinkSync(fpath); } catch (e) {}
    }
  }
  if (dirty) saveMeta();
}
setInterval(cleanup, 60 * 1000);
cleanup();

/* ---------- 路由 ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'POST' && u.pathname === '/api/upload') {
      return handleUpload(req, res, u);
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/media/')) {
      return handleMedia(req, res, u.pathname.slice('/api/media/'.length));
    }
    if (req.method === 'GET' && u.pathname.startsWith('/api/status/')) {
      return handleStatus(req, res, u.pathname.slice('/api/status/'.length), u);
    }
    if (req.method === 'POST' && u.pathname.startsWith('/api/delete/')) {
      return handleDelete(req, res, u.pathname.slice('/api/delete/'.length), u);
    }
    if (req.method === 'GET' && u.pathname === '/api/lan') {
      return sendJSON(res, 200, { port: PORT, addresses: lanAddresses() });
    }

    // 页面
    if (req.method === 'GET') {
      if (u.pathname === '/' || u.pathname === '/index.html') return serveStatic(res, 'index.html');
      if (u.pathname.startsWith('/v/')) return serveStatic(res, 'view.html');
      if (u.pathname.startsWith('/s/')) return serveStatic(res, 'status.html');
    }

    sendJSON(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('请求处理出错:', e);
    try { sendJSON(res, 500, { error: 'server_error' }); } catch (e2) {}
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('一眼即焚 OnePeek 已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  for (const ip of lanAddresses()) {
    console.log('  局域网访问: http://' + ip + ':' + PORT);
  }
});
