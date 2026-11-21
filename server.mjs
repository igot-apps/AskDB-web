// AskDB web version for Render (or any Node host): serves web/dist and the /api/db endpoint.
// Set APP_PASSWORD in the host's environment.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';



const { default: handler } = await import('./server/handler.mjs');

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 10000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Slow down password guessing: after 10 wrong passwords from one address, block it for 15 minutes.
const fails = new Map(); // ip -> { count, until }
const MAX_FAILS = 10, BLOCK_MS = 15 * 60 * 1000;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

async function handleApi(req, res) {
  const ip = clientIp(req);
  const f = fails.get(ip);
  if (f && f.until > Date.now()) {
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Too many wrong passwords. Please wait 15 minutes and try again.' }));
  }
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 1e6) return res.destroy(); }
  const response = await handler(new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'POST' ? body : undefined,
  }));
  if (response.status === 401) {
    const expired = f && f.until && f.until <= Date.now();
    const n = (expired ? 0 : (f?.count || 0)) + 1;
    fails.set(ip, { count: n, until: n >= MAX_FAILS ? Date.now() + BLOCK_MS : 0 });
  } else if (response.status === 200) fails.delete(ip);
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(await response.text());
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(dist, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/api/db') {
    handleApi(req, res).catch(() => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'The AskDB server had a problem.' })); });
  } else serveStatic(req, res);
}).listen(PORT, () => console.log(`AskDB web listening on port ${PORT}`));
