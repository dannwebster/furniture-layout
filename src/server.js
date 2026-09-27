#!/usr/bin/env node
// Local server for the furniture layout page. No dependencies.
//   node server.js [data-dir] [--output <dir>] [--open]
//   GET  /                 the layout page
//   GET  /room3d.html      the 3D view (opened as a popup from the layout page)
//   GET  /api/project      { dataDir, files, photos }: room_layout.json, material_colors.json, every .json under
//                          furniture/ and rugs/ (paths relative to the data dir), plus furniture_placements.json;
//                          photos maps product paths (minus .json) to their main photo from fetch-photos.js
//   GET  /photos/...       those photos, from <output>/photos/
//   PUT  /api/placements   write <output>/furniture_placements.json (POST also accepted, for sendBeacon)
//   POST /api/export?name= write the page's Export data / Export image file (layout-<timestamp>.json|png)
//                          to <output>/, returning { path }
//   GET  /api/events       server-sent events: "change" when data files change, "page" when a page changes
//   node server.js [data-dir] --build
//                          instead of serving, write <output>/furniture-layout.html: one standalone page with
//                          the project data and the 3D view baked in, which runs from file:// with no server
// The data files live outside the program: pass the folder on the command line (or set DATA_DIR).
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const USAGE = `Usage: node server.js [data-dir] [options]

  data-dir             folder holding room_layout.json, material_colors.json, furniture/ and rugs/
                       (same as --data; default: $DATA_DIR, else ../data next to the program)

Options:
  -d, --data <dir>     where the input files are read from
  -o, --output <dir>   where furniture_placements.json (and the --build page) is written
                       (default: $OUTPUT_DIR, else <data-dir>/../output when the data folder is
                       named "data", else <data-dir>/output)
      --open           open the page in a browser once the server is listening
  -b, --build          don't serve: write <output-dir>/furniture-layout.html, a single page with all
                       the data baked in that works without the server (edits save to the browser)
  -h, --help           show this message

Environment: PORT (default 3000), HOST (default 127.0.0.1), DATA_DIR, OUTPUT_DIR.
Command-line options win over the environment.`;

function fail(message) {
  console.error(`server.js: ${message}`);
  console.error(`Run "node server.js --help" for usage.`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { data: null, output: null, open: false, build: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 1 ? arg.slice(0, eq) : arg;
    const inline = eq > 1 ? arg.slice(eq + 1) : null;
    const value = () => {
      const v = inline !== null ? inline : argv[++i];
      if (!v) fail(`${flag} needs a directory`);
      return v;
    };
    switch (flag) {
      case '-d': case '--data': opts.data = value(); break;
      case '-o': case '--output': opts.output = value(); break;
      case '--open': opts.open = true; break;
      case '-b': case '--build': opts.build = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (flag.startsWith('-')) fail(`unknown option ${flag}`);
        positional.push(flag);
    }
  }
  if (positional.length > 1) fail(`expected one data directory, got ${positional.length}`);
  if (positional.length) {
    if (opts.data) fail('the data directory was given twice');
    opts.data = positional[0];
  }
  return opts;
}

// Placements belong next to the data they describe: a sibling of a folder literally named "data"
// (which keeps this repo's own data/ + output/ layout), otherwise inside the data folder itself.
function defaultOutputDir(dataDir) {
  return path.basename(dataDir).toLowerCase() === 'data'
    ? path.join(dataDir, '..', 'output')
    : path.join(dataDir, 'output');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(USAGE); process.exit(0); }

const APP_DIR = __dirname;
const PAGE_FILE = 'furniture-layout.html';
const VIEW3D_FILE = 'room3d.html';
const ROOM_FILE = 'room_layout.json';
const COLORS_FILE = 'material_colors.json';
const PRODUCT_DIRS = ['furniture', 'rugs']; // under DATA_DIR; one JSON file per product, any depth
const PLACEMENTS_FILE = 'furniture_placements.json'; // under OUTPUT_DIR
const PHOTO_MANIFEST = 'sources.json'; // written by fetch-photos.js beside each product's photos
const IMAGE_TYPES = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.avif': 'image/avif', '.gif': 'image/gif' };
const MAX_BODY = 1024 * 1024;
const MAX_EXPORT = 50 * 1024 * 1024; // a plan PNG runs to a few MB
// Exports are written straight into OUTPUT_DIR, so only the page's own timestamped names are accepted.
const EXPORT_NAME = /^layout-\d{8}T\d{6}Z\.(json|png)$/;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// A data project that keeps its input in data/ (beside the output/ we write) can be named either
// way: given the project root, descend into data/ when that's where the room file actually is.
function resolveDataDir(dir) {
  if (fs.existsSync(path.join(dir, ROOM_FILE))) return dir;
  const nested = path.join(dir, 'data');
  return fs.existsSync(path.join(nested, ROOM_FILE)) ? nested : dir;
}

const DATA_DIR = resolveDataDir(path.resolve(args.data || process.env.DATA_DIR || path.join(__dirname, '..', 'data')));
const OUTPUT_DIR = path.resolve(args.output || process.env.OUTPUT_DIR || defaultOutputDir(DATA_DIR));
const PHOTOS_DIR = path.join(OUTPUT_DIR, 'photos'); // fetch-photos.js's default --out

// Fail loudly on a bad path rather than serving an empty room.
try {
  if (!fs.statSync(DATA_DIR).isDirectory()) fail(`not a directory: ${DATA_DIR}`);
} catch (err) {
  if (err.code === 'ENOENT') fail(`data directory not found: ${DATA_DIR}`);
  fail(`cannot read data directory ${DATA_DIR}: ${err.message}`);
}
if (!fs.existsSync(path.join(DATA_DIR, ROOM_FILE))) {
  console.warn(`Warning: no ${ROOM_FILE} in ${DATA_DIR}`);
}

// Relative posix paths (from DATA_DIR) of every .json file under dir (recursive, skipping dot-folders).
async function listJson(dir) {
  const out = [];
  async function walk(rel) {
    let entries;
    try { entries = await fsp.readdir(path.join(DATA_DIR, rel), { withFileTypes: true }); }
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

// Main photo per product, from the sources.json files fetch-photos.js writes under <output>/photos/:
// { "furniture/room_and_board/hudson_dresser": "photos/furniture/room_and_board/hudson_dresser/01-product.webp" }.
// Keys are product paths minus .json; values are URLs relative to the page, which /photos/ serves and a
// --build page (written to OUTPUT_DIR, beside photos/) resolves on its own.
async function readPhotos() {
  const photos = {};
  async function walk(rel) {
    let entries;
    try { entries = await fsp.readdir(path.join(PHOTOS_DIR, rel), { withFileTypes: true }); }
    catch (err) { if (err.code === 'ENOENT') return; throw err; }
    for (const e of entries) {
      if (e.isDirectory()) { await walk(path.posix.join(rel, e.name)); continue; }
      if (e.name !== PHOTO_MANIFEST) continue;
      let list;
      try { list = JSON.parse(await fsp.readFile(path.join(PHOTOS_DIR, rel, e.name), 'utf8')).photos; } catch { continue; }
      const main = Array.isArray(list) && (list.find(p => p && p.kind === 'product' && p.file) || list.find(p => p && p.file));
      if (main && path.basename(main.file) === main.file) {
        photos[rel] = ['photos', ...rel.split('/'), main.file].map(encodeURIComponent).join('/');
      }
    }
  }
  for (const dir of PRODUCT_DIRS) await walk(dir);
  return photos;
}

async function readProject() {
  const files = [];
  const add = async (rel, dir = DATA_DIR) => {
    try { files.push({ path: rel, text: await fsp.readFile(path.join(dir, rel), 'utf8') }); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  };
  await add(ROOM_FILE);
  await add(PLACEMENTS_FILE, OUTPUT_DIR);
  await add(COLORS_FILE);
  for (const dir of PRODUCT_DIRS) for (const rel of await listJson(dir)) await add(rel);
  return files;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function writePlacements(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (err) { throw Object.assign(new Error(`invalid JSON: ${err.message}`), { status: 400 }); }
  if (!doc || typeof doc !== 'object' || typeof doc.placements !== 'object') {
    throw Object.assign(new Error('expected an object with "placements"'), { status: 400 });
  }
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const target = path.join(OUTPUT_DIR, PLACEMENTS_FILE);
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

// OUTPUT_DIR isn't watched: our own writes to furniture_placements.json are deliberately not broadcast.
let changeTimer = null, pageTimer = null;
function onDataChange(filename) {
  if (!filename) return;
  const rel = String(filename).replace(/\\/g, '/');
  if (rel === ROOM_FILE || rel === COLORS_FILE || PRODUCT_DIRS.some(d => rel === d || rel.startsWith(d + '/'))) {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => broadcast('change'), 150);
  }
}
function onAppChange(filename) {
  if (filename !== PAGE_FILE && filename !== VIEW3D_FILE) return;
  clearTimeout(pageTimer);
  pageTimer = setTimeout(() => broadcast('page'), 150);
}
function watchFiles() {
  try {
    fs.watch(DATA_DIR, { recursive: true }, (_type, filename) => onDataChange(filename));
    fs.watch(APP_DIR, (_type, filename) => onAppChange(filename && String(filename)));
  } catch (err) {
    console.warn(`File watching unavailable (${err.message}); use "Reload files" in the page.`);
  }
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
      return send(res, 200, await fsp.readFile(path.join(APP_DIR, PAGE_FILE)), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/' + VIEW3D_FILE) {
      return send(res, 200, await fsp.readFile(path.join(APP_DIR, VIEW3D_FILE)), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/project') {
      const body = { dataDir: DATA_DIR, files: await readProject(), photos: await readPhotos() };
      return send(res, 200, JSON.stringify(body), 'application/json; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/photos/')) {
      const file = path.join(PHOTOS_DIR, decodeURIComponent(url.pathname.slice('/photos/'.length)));
      const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
      if (!type || !file.startsWith(PHOTOS_DIR + path.sep)) return send(res, 404, 'Not found');
      try { return send(res, 200, await fsp.readFile(file), type); }
      catch (err) { if (err.code === 'ENOENT') return send(res, 404, 'Not found'); throw err; }
    }
    if ((req.method === 'PUT' || req.method === 'POST') && url.pathname === '/api/placements') {
      await writePlacements((await readBody(req)).toString('utf8'));
      return send(res, 204, '');
    }
    if (req.method === 'POST' && url.pathname === '/api/export') {
      const name = url.searchParams.get('name') || '';
      if (!EXPORT_NAME.test(name)) return send(res, 400, `bad export name "${name}"`);
      const body = await readBody(req, MAX_EXPORT);
      await fsp.mkdir(OUTPUT_DIR, { recursive: true });
      const target = path.join(OUTPUT_DIR, name);
      await fsp.writeFile(target, body);
      return send(res, 200, JSON.stringify({ path: target }), 'application/json; charset=utf-8');
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

// ---- Standalone build ----
// JSON for an inline <script>: escaping "<" keeps "</script>" and "<!--" in the data from ending it.
const inlineJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
// Insert before </head>; a replacer function so "$" in the inserted text isn't read as a pattern.
function injectHead(html, snippet, file) {
  if (!/<\/head>/i.test(html)) throw new Error(`no </head> in ${file}`);
  return html.replace(/<\/head>/i, () => `${snippet}\n</head>`);
}

async function build() {
  const files = await readProject();
  const room3d = injectHead(await fsp.readFile(path.join(APP_DIR, VIEW3D_FILE), 'utf8'),
    '<script>window.FURNITURE_LAYOUT_STANDALONE = true;</script>', VIEW3D_FILE);
  const payload = { built: new Date().toISOString(), dataDir: DATA_DIR, files, photos: await readPhotos(), room3d };
  const page = injectHead(await fsp.readFile(path.join(APP_DIR, PAGE_FILE), 'utf8'),
    `<script>window.FURNITURE_LAYOUT_EMBEDDED = ${inlineJson(payload)};</script>`, PAGE_FILE);
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const target = path.join(OUTPUT_DIR, PAGE_FILE);
  await fsp.writeFile(target, page, 'utf8');
  const placed = files.some(f => f.path === PLACEMENTS_FILE) ? `with ${PLACEMENTS_FILE}` : `no ${PLACEMENTS_FILE} yet`;
  console.log(`Read ${files.length} files from ${DATA_DIR} (${placed})`);
  console.log(`Wrote ${target} (${(Buffer.byteLength(page) / 1024).toFixed(0)} KB)`);
}

function serve() {
  watchFiles();
  // Keep event streams alive through idle periods.
  setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`;
    console.log(`Furniture layout running at ${url}`);
    console.log(`Reading ${ROOM_FILE} and ${PRODUCT_DIRS.map(d => d + '/**/*.json').join(', ')} from ${DATA_DIR}`);
    console.log(`Saving ${PLACEMENTS_FILE} to ${OUTPUT_DIR}`);
    if (args.open) {
      const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
}

if (args.build) build().catch(err => { console.error(`server.js: build failed: ${err.message}`); process.exit(1); });
else serve();
