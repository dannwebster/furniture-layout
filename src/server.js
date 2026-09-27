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
//   POST /api/export-zip?name=&content=data|site
//                          write layout-<timestamp>.zip (data: the posted Export data JSON + its products'
//                          photos) or layout-site-<timestamp>.zip (the --build page as index.html + all photos)
//   POST /api/render       render the 3D view's current point of view as a photo (see render.mjs) into
//                          <output>/renders/render-<timestamp>/, returning that render's meta.json
//   GET  /api/render/config which image providers and models the keys in .env allow (no keys in the reply)
//   GET  /api/renders      the meta.json of every saved render, newest first
//   GET  /renders/...      the saved render images, from <output>/renders/
//   GET  /api/events       server-sent events: "change" when data files change, "page" when a page changes,
//                          "render" with { stage, ... } while a render runs
//   node server.js [data-dir] --build
//                          instead of serving, write <output>/furniture-layout.html: one standalone page with
//                          the project data and the 3D view baked in, which runs from file:// with no server
// The data files live outside the program: pass the folder on the command line (or set DATA_DIR).
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

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
Command-line options win over the environment.

While working on the program itself, "npm run dev" runs this file under node --watch-path, so editing
server.js or render.mjs restarts it. The two HTML pages need no restart either way: a change to them
is broadcast on the event stream and they reload themselves.

Rendering the 3D view as a photo needs API keys, read from .env in the data folder or the project
around it, else beside package.json (a real environment variable wins over all of them):
GEMINI_API_KEY and/or OPENAI_API_KEY for the image model, ANTHROPIC_API_KEY for the optional
prompt-writing and result-checking passes. RENDER_MODEL_GEMINI, RENDER_MODEL_OPENAI,
RENDER_PROMPT_MODEL and RENDER_PROVIDER override the defaults.`;

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

// API keys for the render feature live in a .env file rather than the environment, since "npm start"
// on Windows makes exported variables awkward. The data project's .env is read first — keys and model
// choices belong with the room they're rendering — then this repo's, and a real environment variable
// wins over both. Whichever file sets a name first keeps it.
function loadEnv(...dirs) {
  for (const dir of dirs) {
    let text;
    try { text = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || line.trimStart().startsWith('#')) continue;
      const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}

const APP_DIR = __dirname;
const PAGE_FILE = 'furniture-layout.html';
const VIEW3D_FILE = 'room3d.html';
const RENDER_FILE = 'render.mjs'; // beside this file; imported on demand, see loadRenderer()
const ROOM_FILE = 'room_layout.json';
const COLORS_FILE = 'material_colors.json';
const PRODUCT_DIRS = ['furniture', 'rugs']; // under DATA_DIR; one JSON file per product, any depth
const PLACEMENTS_FILE = 'furniture_placements.json'; // under OUTPUT_DIR
const PHOTO_MANIFEST = 'sources.json'; // written by fetch-photos.js beside each product's photos
const IMAGE_TYPES = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.avif': 'image/avif', '.gif': 'image/gif' };
const MAX_BODY = 1024 * 1024;
const MAX_EXPORT = 50 * 1024 * 1024; // a plan PNG runs to a few MB
// Exports are written straight into OUTPUT_DIR, so only the page's own timestamped names are accepted.
// 2026-09-26T14-30-12Z; the older compact 20260926T143012Z is still accepted, so earlier renders export.
const STAMP = String.raw`(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z|\d{8}T\d{6}Z)`;
const EXPORT_NAME = new RegExp(`^layout-${STAMP}\\.(json|png)$`);
const ZIP_NAME = new RegExp(`^layout-(site-)?${STAMP}\\.zip$`);
const RENDERS_SUBDIR = 'renders'; // under OUTPUT_DIR; one folder per render, named by timestamp
const RENDER_NAME = new RegExp(`^render-${STAMP}$`); // as render.mjs names them, and all an export may name

// A data project that keeps its input in data/ (beside the output/ we write) can be named either
// way: given the project root, descend into data/ when that's where the room file actually is.
function resolveDataDir(dir) {
  if (fs.existsSync(path.join(dir, ROOM_FILE))) return dir;
  const nested = path.join(dir, 'data');
  return fs.existsSync(path.join(nested, ROOM_FILE)) ? nested : dir;
}

const DATA_DIR = resolveDataDir(path.resolve(args.data || process.env.DATA_DIR || path.join(__dirname, '..', 'data')));
// Now that the data folder is known, read the .env files: the data folder, then the project around it
// (where a nested data/ has its sibling output/), then this repo. DATA_DIR is the one thing they can't
// set, since it had to be resolved to find them; everything below is fair game.
loadEnv(DATA_DIR, path.join(DATA_DIR, '..'), path.join(APP_DIR, '..'));

const OUTPUT_DIR = path.resolve(args.output || process.env.OUTPUT_DIR || defaultOutputDir(DATA_DIR));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
// Which image model each provider uses; override in .env when the providers move on.
const RENDER_MODELS = {
  gemini: process.env.RENDER_MODEL_GEMINI || 'gemini-3-pro-image',
  openai: process.env.RENDER_MODEL_OPENAI || 'gpt-image-2.5-flare',
};
const RENDER_PROMPT_MODEL = process.env.RENDER_PROMPT_MODEL || 'claude-opus-5';
const PHOTOS_DIR = path.join(OUTPUT_DIR, 'photos'); // fetch-photos.js's default --out
const RENDERS_DIR = path.join(OUTPUT_DIR, RENDERS_SUBDIR);

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

// The meta.json of every saved render, newest first. Each render is one folder under <output>/renders/,
// so the folder names sort by time on their own.
async function readRenders() {
  let names;
  try { names = await fsp.readdir(RENDERS_DIR, { withFileTypes: true }); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const metas = [];
  // By digits alone, so the older compact names sort in time order among the hyphenated ones.
  const key = name => name.replace(/\D/g, '');
  for (const e of names.filter(e => e.isDirectory()).sort((a, b) => key(b.name).localeCompare(key(a.name)))) {
    try { metas.push(JSON.parse(await fsp.readFile(path.join(RENDERS_DIR, e.name, 'meta.json'), 'utf8'))); }
    catch { /* a render still being written, or hand-made folder */ }
  }
  return metas;
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

const badRequest = msg => Object.assign(new Error(msg), { status: 400 });
function parseJson(text) {
  try { return JSON.parse(text); } catch (err) { throw badRequest(`invalid JSON: ${err.message}`); }
}
// A placements document as the page posts it; throws a 400 otherwise.
function parsePlacements(text) {
  const doc = parseJson(text);
  if (!doc || typeof doc !== 'object' || typeof doc.placements !== 'object') throw badRequest('expected an object with "placements"');
  return doc;
}

// Write a file into OUTPUT_DIR (folders created as needed) and return its path. The name may be a
// relative path, which is how renders land in their own folder.
async function writeOutput(name, data) {
  const target = path.join(OUTPUT_DIR, name);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, data);
  return target;
}

async function writePlacements(text) {
  const doc = parsePlacements(text);
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
function broadcast(event, data) {
  const payload = JSON.stringify(data === undefined ? {} : data);
  for (const res of clients) res.write(`event: ${event}\ndata: ${payload}\n\n`);
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
const sendJson = (res, value) => send(res, 200, JSON.stringify(value), 'application/json; charset=utf-8');

// An image from a folder under OUTPUT_DIR, named by the rest of the URL. Images only, and never
// outside that folder.
async function sendImage(res, root, rel) {
  const file = path.join(root, decodeURIComponent(rel));
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type || !file.startsWith(root + path.sep)) return send(res, 404, 'Not found');
  try { return send(res, 200, await fsp.readFile(file), type); }
  catch (err) { if (err.code === 'ENOENT') return send(res, 404, 'Not found'); throw err; }
}

// render.mjs is loaded on demand — the SDKs it pulls in are only needed once someone renders, and it's
// ESM from this CommonJS file. The loader would then cache it for the life of the process, so the import
// is keyed on the file's mtime: editing the brief or a provider adapter takes effect on the next render
// with no restart. Unchanged, the same module instance is reused.
function loadRenderer() {
  const file = path.join(APP_DIR, RENDER_FILE);
  let stamp = '';
  try { stamp = String(fs.statSync(file).mtimeMs); } catch { /* let import() report a missing file */ }
  return import(`${pathToFileURL(file).href}?v=${stamp}`);
}

// What the render panel may ask for: a provider needs its key, and the optional Claude passes need theirs.
const renderConfig = () => ({
  providers: { gemini: !!process.env.GEMINI_API_KEY, openai: !!process.env.OPENAI_API_KEY },
  claude: !!process.env.ANTHROPIC_API_KEY,
  models: { ...RENDER_MODELS, prompt: RENDER_PROMPT_MODEL },
  defaultProvider: process.env.RENDER_PROVIDER || 'gemini',
});

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
      return sendJson(res, { dataDir: DATA_DIR, files: await readProject(), photos: await readPhotos() });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/photos/')) {
      return sendImage(res, PHOTOS_DIR, url.pathname.slice('/photos/'.length));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/renders/')) {
      return sendImage(res, RENDERS_DIR, url.pathname.slice('/renders/'.length));
    }
    if ((req.method === 'PUT' || req.method === 'POST') && url.pathname === '/api/placements') {
      await writePlacements((await readBody(req)).toString('utf8'));
      return send(res, 204, '');
    }
    if (req.method === 'POST' && url.pathname === '/api/export') {
      const name = url.searchParams.get('name') || '';
      if (!EXPORT_NAME.test(name)) return send(res, 400, `bad export name "${name}"`);
      return sendJson(res, { path: await writeOutput(name, await readBody(req, MAX_EXPORT)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/export-zip') {
      const name = url.searchParams.get('name') || '', content = url.searchParams.get('content');
      if (!ZIP_NAME.test(name)) return send(res, 400, `bad export name "${name}"`);
      if (content !== 'data' && content !== 'site') return send(res, 400, 'content must be "data" or "site"');
      return sendJson(res, await exportZip(name, content, await readBody(req, MAX_EXPORT)));
    }
    if (req.method === 'GET' && url.pathname === '/api/render/config') {
      return sendJson(res, renderConfig());
    }
    if (req.method === 'GET' && url.pathname === '/api/renders') {
      return sendJson(res, { renders: await readRenders() });
    }
    if (req.method === 'POST' && url.pathname === '/api/export-render') {
      const content = url.searchParams.get('content');
      if (content !== 'prompt' && content !== 'zip') return send(res, 400, 'content must be "prompt" or "zip"');
      return sendJson(res, await exportRender(url.searchParams.get('name') || '', content));
    }
    if (req.method === 'POST' && url.pathname === '/api/render') {
      const { renderView } = await loadRenderer();
      const request = parseJson((await readBody(req, MAX_EXPORT)).toString('utf8'));
      const meta = await renderView(request, {
        dataDir: DATA_DIR, photosDir: PHOTOS_DIR, photoManifest: PHOTO_MANIFEST,
        rendersSubdir: RENDERS_SUBDIR, models: RENDER_MODELS, promptModel: RENDER_PROMPT_MODEL,
        env: process.env, writeOutput, broadcast, badRequest,
      });
      return sendJson(res, meta);
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

// The standalone page: used by --build and by the page's Export site button, which posts the placements
// it shows (placementsText) so the site doesn't depend on the last autosave having reached the disk.
async function buildPage(placementsText) {
  let files = await readProject();
  if (placementsText != null) {
    parsePlacements(placementsText);
    files = files.filter(f => f.path !== PLACEMENTS_FILE).concat({ path: PLACEMENTS_FILE, text: placementsText });
  }
  const photos = await readPhotos();
  const room3d = injectHead(await fsp.readFile(path.join(APP_DIR, VIEW3D_FILE), 'utf8'),
    '<script>window.FURNITURE_LAYOUT_STANDALONE = true;</script>', VIEW3D_FILE);
  const payload = { built: new Date().toISOString(), dataDir: DATA_DIR, files, photos, room3d };
  const page = injectHead(await fsp.readFile(path.join(APP_DIR, PAGE_FILE), 'utf8'),
    `<script>window.FURNITURE_LAYOUT_EMBEDDED = ${inlineJson(payload)};</script>`, PAGE_FILE);
  return { page, files, photos };
}

async function build() {
  const { page, files } = await buildPage();
  const target = await writeOutput(PAGE_FILE, page);
  const placed = files.some(f => f.path === PLACEMENTS_FILE) ? `with ${PLACEMENTS_FILE}` : `no ${PLACEMENTS_FILE} yet`;
  console.log(`Read ${files.length} files from ${DATA_DIR} (${placed})`);
  console.log(`Wrote ${target} (${(Buffer.byteLength(page) / 1024).toFixed(0)} KB)`);
}

// ---- Zip exports ----
// A minimal zip writer (no dependencies): images are stored as they are (WebP/JPEG/PNG don't shrink, and
// deflating MBs of them would block the server), everything else is deflated where it helps.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = IMAGE_TYPES[path.extname(name).toLowerCase()] ? data : zlib.deflateRawSync(data);
    const method = deflated.length < data.length ? 8 : 0;
    const body = method ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// Shared by Export zip, Export site and a render's Export zip: the main file (or files) plus the photos
// they refer to. Photo URLs are the relative "photos/..." ones readPhotos() and a render's meta.json
// hand out, so they keep the same paths inside the zip.
async function writeExportZip(name, main, photoUrls) {
  const mains = Array.isArray(main) ? main : [main];
  const photos = await Promise.all([...new Set(photoUrls)].map(async u => {
    const rel = u.split('/').map(decodeURIComponent);
    try { return { name: rel.join('/'), data: await fsp.readFile(path.join(OUTPUT_DIR, ...rel)) }; }
    catch (err) { if (err.code !== 'ENOENT') throw err; return null; }
  }));
  const kept = photos.filter(Boolean);
  return { path: await writeOutput(name, makeZip([...mains, ...kept])), photos: kept.length };
}

// content=data: the page's Export data JSON (request body) and photos of the products listed in it;
// content=site: the --build page as index.html (with the posted placements) and every product photo it can show.
async function exportZip(name, content, body) {
  if (content === 'data') {
    const doc = parseJson(body.toString('utf8'));
    const photos = await readPhotos();
    const files = (Array.isArray(doc && doc.products) ? doc.products : []).map(p => String(p && p.file || '').replace(/\.json$/i, ''));
    return writeExportZip(name, { name: name.replace(/\.zip$/, '.json'), data: body }, files.map(f => photos[f]).filter(Boolean));
  }
  const site = await buildPage(body.toString('utf8'));
  return writeExportZip(name, { name: 'index.html', data: Buffer.from(site.page, 'utf8') }, Object.values(site.photos));
}

// The 3D view's Export prompt / Export zip: lift one render out of renders/<name>/ into OUTPUT_DIR,
// beside the layout exports. content=prompt writes the brief that was actually sent (Claude's rewrite
// when there is one) as <name>-prompt.txt; content=zip bundles the whole render — both briefs, the
// geometry and mask passes, the picture, meta.json, and the product photos it used as references.
async function exportRender(name, content) {
  if (!RENDER_NAME.test(name)) throw badRequest(`bad render name "${name}"`);
  const dir = path.join(RENDERS_DIR, name);
  const read = async file => {
    try { return await fsp.readFile(path.join(dir, file)); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  };
  const metaText = await read('meta.json');
  if (!metaText) throw badRequest(`no render called "${name}"`);
  const meta = parseJson(metaText.toString('utf8'));
  const files = meta.files || {};
  const brief = files.promptClaude || files.prompt;
  if (content === 'prompt') {
    const text = brief && await read(brief);
    if (!text) throw badRequest(`${name} has no prompt on disk`);
    return { path: await writeOutput(`${name}-prompt.txt`, text), from: brief };
  }
  const wanted = [files.prompt, files.promptClaude, files.pov, files.mask, ...(files.renders || []), 'meta.json'];
  const entries = [];
  for (const file of wanted.filter(Boolean)) {
    const data = await read(file);
    if (data) entries.push({ name: file, data });
  }
  const photos = (meta.references || []).map(r => r.photo).filter(u => typeof u === 'string' && u.startsWith('photos/'));
  const zip = await writeExportZip(`${name}.zip`, entries, photos);
  return { ...zip, files: entries.length };
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
