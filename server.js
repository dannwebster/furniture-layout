#!/usr/bin/env node
// Local server for the furniture layout page. No dependencies.
//   GET  /                 the layout page
//   GET  /api/project      room_layout.json, furniture_placements.json and every .json under furniture/
//   PUT  /api/placements   write furniture_placements.json (POST also accepted, for sendBeacon)
//   GET  /api/events       server-sent events: "change" when project files change, "page" when the page changes
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PAGE_FILE = 'furniture-layout.html';
const ROOM_FILE = 'room_layout.json';
const FURNITURE_DIR = 'furniture';
const PLACEMENTS_FILE = 'furniture_placements.json';
const MAX_BODY = 1024 * 1024;

// Relative posix paths of every .json file under dir (recursive, skipping dot-folders).
async function listJson(dir) {
  const out = [];
  async function walk(rel) {
    let entries;
    try { entries = await fsp.readdir(path.join(ROOT, rel), { withFileTypes: true }); }
    catch (err) { if (err.code === 'ENOENT') return; throw err; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const child = path.posix.join(rel, e.name);
      if (e.isDirectory()) await walk(child);
      else if (e.isFile() && /\.json$/i.test(e.name)) out.push(child);
    }
  }
  await walk(dir);
  return out.sort();
}

async function readProject() {
  const files = [];
  const add = async rel => {
    try { files.push({ path: rel, text: await fsp.readFile(path.join(ROOT, rel), 'utf8') }); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  };
  await add(ROOM_FILE);
  await add(PLACEMENTS_FILE);
  for (const rel of await listJson(FURNITURE_DIR)) await add(rel);
  return files;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function writePlacements(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (err) { throw Object.assign(new Error(`invalid JSON: ${err.message}`), { status: 400 }); }
  if (!doc || typeof doc !== 'object' || typeof doc.placements !== 'object') {
    throw Object.assign(new Error('expected an object with "placements"'), { status: 400 });
  }
  const target = path.join(ROOT, PLACEMENTS_FILE);
  const body = JSON.stringify(doc, null, 2) + '\n';
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, body, 'utf8');
  try {
    await fsp.rename(tmp, target);
  } catch {
    // Windows can refuse the rename while an editor holds the file; write in place instead.
    await fsp.writeFile(target, body, 'utf8');
    await fsp.rm(tmp, { force: true });
  }
}

// ---- Live updates ----
const clients = new Set();
function broadcast(event) {
  for (const res of clients) res.write(`event: ${event}\ndata: {}\n\n`);
}

let changeTimer = null, pageTimer = null;
function onFsChange(filename) {
  if (!filename) return;
  const rel = String(filename).replace(/\\/g, '/');
  if (rel === PAGE_FILE) {
    clearTimeout(pageTimer);
    pageTimer = setTimeout(() => broadcast('page'), 150);
  } else if (rel === ROOM_FILE || (rel.startsWith(FURNITURE_DIR + '/') || rel === FURNITURE_DIR)) {
    // Our own writes to furniture_placements.json are deliberately not broadcast.
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => broadcast('change'), 150);
  }
}
try {
  fs.watch(ROOT, { recursive: true }, (_type, filename) => onFsChange(filename));
} catch (err) {
  console.warn(`File watching unavailable (${err.message}); use "Reload files" in the page.`);
}

// ---- HTTP ----
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/' + PAGE_FILE)) {
      return send(res, 200, await fsp.readFile(path.join(ROOT, PAGE_FILE)), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/project') {
      return send(res, 200, JSON.stringify({ files: await readProject() }), 'application/json; charset=utf-8');
    }
    if ((req.method === 'PUT' || req.method === 'POST') && url.pathname === '/api/placements') {
      await writePlacements(await readBody(req));
      return send(res, 204, '');
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    send(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, err.message);
  }
});

// Keep event streams alive through idle periods.
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`;
  console.log(`Furniture layout running at ${url}`);
  console.log(`Reading ${ROOM_FILE} and ${FURNITURE_DIR}/**/*.json; saving to ${PLACEMENTS_FILE}`);
  if (process.argv.includes('--open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
