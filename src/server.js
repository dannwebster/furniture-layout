#!/usr/bin/env node
// Local server for the furniture layout page. No dependencies.
//   node server.js [data-dir] [--output <dir>] [--open]
//   GET  /                 the layout page
//   GET  /room3d.html      the 3D view (opened as a popup from the layout page)
//   GET  /api/project      <data>/room_layout.json, <data>/material_colors.json, every .json under <data>/furniture/
//                          and <data>/rugs/ (paths relative to the data dir), plus furniture_placements.json
//   PUT  /api/placements   write <output>/furniture_placements.json (POST also accepted, for sendBeacon)
//   GET  /api/events       server-sent events: "change" when data files change, "page" when a page changes
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
  -o, --output <dir>   where furniture_placements.json is written
                       (default: $OUTPUT_DIR, else <data-dir>/../output when the data folder is
                       named "data", else <data-dir>/output)
      --open           open the page in a browser once the server is listening
  -h, --help           show this message

Environment: PORT (default 3000), HOST (default 127.0.0.1), DATA_DIR, OUTPUT_DIR.
Command-line options win over the environment.`;

function fail(message) {
  console.error(`server.js: ${message}`);
  console.error(`Run "node server.js --help" for usage.`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { data: null, output: null, open: false, help: false };
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
const DATA_DIR = path.resolve(args.data || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const OUTPUT_DIR = path.resolve(args.output || process.env.OUTPUT_DIR || defaultOutputDir(DATA_DIR));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PAGE_FILE = 'furniture-layout.html';
const VIEW3D_FILE = 'room3d.html';
const ROOM_FILE = 'room_layout.json';
const COLORS_FILE = 'material_colors.json';
const PRODUCT_DIRS = ['furniture', 'rugs']; // under DATA_DIR; one JSON file per product, any depth
const PLACEMENTS_FILE = 'furniture_placements.json'; // under OUTPUT_DIR
const MAX_BODY = 1024 * 1024;

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
try {
  fs.watch(DATA_DIR, { recursive: true }, (_type, filename) => onDataChange(filename));
  fs.watch(APP_DIR, (_type, filename) => onAppChange(filename && String(filename)));
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
      return send(res, 200, await fsp.readFile(path.join(APP_DIR, PAGE_FILE)), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/' + VIEW3D_FILE) {
      return send(res, 200, await fsp.readFile(path.join(APP_DIR, VIEW3D_FILE)), 'text/html; charset=utf-8');
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
  console.log(`Reading ${ROOM_FILE} and ${PRODUCT_DIRS.map(d => d + '/**/*.json').join(', ')} from ${DATA_DIR}`);
  console.log(`Saving ${PLACEMENTS_FILE} to ${OUTPUT_DIR}`);
  if (process.argv.includes('--open')) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});
