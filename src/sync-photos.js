#!/usr/bin/env node
// Bring each photo folder's sources.json in line with the images actually on disk. No dependencies.
//   node sync-photos.js [filter...] [--data <dir>] [--out <dir>] [--dry-run]
// For photos saved by hand into <output>/photos/<product path minus .json>/: writes the missing
// sources.json (the server only finds photos through it), adds images the manifest doesn't list,
// drops entries whose file is gone, and renames a folder whose name is a near miss (edit distance
// <= 2) for exactly one product file beside it. Hand-added entries carry url: null and manual: true.
// --data / --out resolve exactly as in fetch-photos.js. --dry-run reports without writing.
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PRODUCT_DIRS = ['furniture', 'rugs'];
const MANIFEST = 'sources.json';
const IMAGE_EXT = /\.(webp|jpe?g|png|avif|gif)$/i; // same set server.js serves
const KINDS = ['product-alt', 'product', 'room', 'gallery', 'detail', 'dimensions'];
const MAX_RENAME_DISTANCE = 2;

// ---- CLI ----
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const dataIdx = Math.max(argv.indexOf('--data'), argv.indexOf('-d'));
const outIdx = argv.indexOf('--out');
function optionValue(idx, flag) {
  const v = argv[idx + 1];
  if (!v || v.startsWith('-')) { console.error(`sync-photos: ${flag} needs a directory`); process.exit(1); }
  return path.resolve(v);
}
// Same rules as server.js and fetch-photos.js.
function resolveDataDir(dir) {
  if (fs.existsSync(path.join(dir, 'room_layout.json'))) return dir;
  const nested = path.join(dir, 'data');
  return fs.existsSync(path.join(nested, 'room_layout.json')) ? nested : dir;
}
function defaultOutputDir(dataDir) {
  return path.basename(dataDir).toLowerCase() === 'data'
    ? path.join(dataDir, '..', 'output')
    : path.join(dataDir, 'output');
}
const DATA_DIR = resolveDataDir(dataIdx >= 0 ? optionValue(dataIdx, argv[dataIdx])
  : path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')));
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || defaultOutputDir(DATA_DIR));
const OUT = outIdx >= 0 ? optionValue(outIdx, '--out') : path.join(OUTPUT_DIR, 'photos');
const takenValues = new Set([dataIdx, outIdx].filter(i => i >= 0).map(i => i + 1));
const filters = argv.filter((a, i) => !a.startsWith('-') && !takenValues.has(i));

// ---- Helpers ----
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

// Every folder under root (relative, posix) that directly holds an image, with those images sorted.
async function listPhotoDirs(root) {
  const out = [];
  async function walk(rel) {
    let entries;
    try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); }
    catch (err) { if (err.code === 'ENOENT') return; throw err; }
    const images = entries.filter(e => e.isFile() && IMAGE_EXT.test(e.name)).map(e => e.name).sort();
    if (images.length && rel) out.push({ rel, images });
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) await walk(rel ? path.posix.join(rel, e.name) : e.name);
  }
  await walk('');
  return out;
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// fetch-photos names files NN-<kind>[-caption].<ext>; anything else gets a kind by position.
function kindOf(file, hasProduct) {
  const m = /^\d+-(.+)\.[^.]+$/.exec(file);
  const kind = m && KINDS.find(k => m[1] === k || m[1].startsWith(k + '-'));
  return kind || (hasProduct ? 'gallery' : 'product');
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

// ---- Main ----
async function syncFolder(key, images, doc) {
  const dir = path.join(OUT, key);
  const file = path.join(dir, MANIFEST);
  const oldText = await fsp.readFile(file, 'utf8').catch(() => null);
  let manifest = null;
  try { manifest = oldText && JSON.parse(oldText); } catch { /* rebuilt below */ }
  const name = doc?.furniture?.name || key;
  if (!manifest || typeof manifest !== 'object') {
    const meta = doc?.metadata || {};
    manifest = {
      product_file: `${key}.json`,
      name,
      page_url: meta.source_variant_url || meta.product_url || null,
      page_title: null,
      retrieved: new Date().toISOString(),
      photos: [],
    };
  }
  const listed = Array.isArray(manifest.photos) ? manifest.photos : [];
  const onDisk = new Set(images);
  const kept = listed.filter(p => p && p.file && onDisk.has(p.file));
  const known = new Set(kept.map(p => p.file));
  const added = [];
  for (const f of images) {
    if (known.has(f)) continue;
    const kind = kindOf(f, kept.concat(added).some(p => p.kind === 'product'));
    added.push({ file: f, kind, caption: name, url: null, manual: true });
  }
  manifest.photos = kept.concat(added);
  const newText = JSON.stringify(manifest, null, 2) + '\n';
  if (newText === oldText) return 'ok';
  if (!dryRun) await fsp.writeFile(file, newText);
  if (oldText === null) return `created (${added.length} photo${added.length === 1 ? '' : 's'})`;
  return `updated (+${added.length}, −${listed.length - kept.length})`;
}

(async () => {
  console.log(`Reading products from ${DATA_DIR}`);
  console.log(`Syncing photos in ${OUT}${dryRun ? ' (dry run)' : ''}`);
  const products = new Map();
  for (const d of PRODUCT_DIRS) for (const rel of await listJson(d)) products.set(rel.replace(/\.json$/i, ''), rel);
  const matches = key => !filters.length || filters.some(f => key.toLowerCase().includes(f.toLowerCase()));

  const folders = (await listPhotoDirs(OUT)).filter(f => matches(f.rel));
  if (!folders.length) { console.error('No photo folders matched.'); process.exit(1); }
  const covered = new Set();
  let problems = 0;
  for (const { rel, images } of folders) {
    let key = rel;
    let note = '';
    if (!products.has(key)) {
      const parent = path.posix.dirname(rel);
      const base = path.posix.basename(rel);
      const near = [...products.keys()].filter(k => path.posix.dirname(k) === parent
        && levenshtein(path.posix.basename(k), base) <= MAX_RENAME_DISTANCE);
      if (near.length !== 1) {
        problems++;
        console.log(`  ✗ ${rel}: no product file${near.length ? `; could be ${near.join(', ')}` : ''}`);
        continue;
      }
      if (fs.existsSync(path.join(OUT, near[0]))) {
        problems++;
        console.log(`  ✗ ${rel}: looks like ${near[0]}, but that folder already exists`);
        continue;
      }
      if (!dryRun) await fsp.rename(path.join(OUT, rel), path.join(OUT, near[0]));
      key = near[0];
      note = `renamed from ${path.posix.basename(rel)}, `;
    }
    covered.add(key);
    const doc = await readJson(path.join(DATA_DIR, products.get(key)));
    const status = await syncFolder(key, images, doc);
    console.log(`  ${status === 'ok' && !note ? ' ' : '✓'} ${key}: ${note}${status}`);
  }

  const missing = [...products.keys()].filter(k => matches(k) && !covered.has(k));
  if (missing.length) {
    console.log(`No photos for ${missing.length} product(s):`);
    for (const k of missing) console.log(`    ${k}`);
  }
  if (problems) process.exitCode = 1;
})();
