#!/usr/bin/env node
// Download product photos for every file under <data>/furniture/ and <data>/rugs/. No dependencies.
//   node fetch-photos.js [filter...] [--data <dir>] [--force] [--out <dir>]
// Photos land in <output>/photos/<same path as the product file, minus .json>/, e.g.
//   output/photos/furniture/room_and_board/hudson_dresser/01-product.webp
// alongside a sources.json listing where each file came from. Re-runs skip photos already on disk
// (by source URL); --force downloads everything again. Filters match against the product path.
// --data (or DATA_DIR) says where the product files live, default ../data; --out overrides the
// photo folder, which otherwise follows the output dir server.js would use (OUTPUT_DIR, else the
// sibling output/ of a folder named "data", else <data>/output).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PRODUCT_DIRS = ['furniture', 'rugs'];
const MANIFEST = 'sources.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const PAGE_CONCURRENCY = 4;
const IMAGE_CONCURRENCY = 6;
const SCENE7 = 'https://rnb.scene7.com/is/image/roomandboard/';
const SCENE7_MAX = 4000; // largest width/height Scene7 will serve

// ---- CLI ----
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const dataIdx = Math.max(argv.indexOf('--data'), argv.indexOf('-d'));
const outIdx = argv.indexOf('--out');
function optionValue(idx, flag) {
  const v = argv[idx + 1];
  if (!v || v.startsWith('-')) { console.error(`fetch-photos: ${flag} needs a directory`); process.exit(1); }
  return path.resolve(v);
}
// Same rules as server.js: the data dir may be a project root holding data/, and generated files go
// to the sibling output/ of a folder named "data", else to <data-dir>/output.
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
// Filters are the bare words: drop every flag and the directory that follows --data / --out.
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

// Run fn over items with at most n in flight; results keep input order.
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const pageSlot = limiter(PAGE_CONCURRENCY);
const imageSlot = limiter(IMAGE_CONCURRENCY);

async function get(url, accept) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      return res;
    } catch (err) {
      const retryable = !err.status || err.status === 429 || err.status >= 500;
      if (!retryable || attempt >= 3) throw new Error(`${err.message} for ${url}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

// Shared across products: rug sizes often point at the same page and the same photos.
const pageCache = new Map();
function fetchPage(url) {
  if (!pageCache.has(url)) pageCache.set(url, pageSlot(async () => (await get(url, 'text/html')).text()));
  return pageCache.get(url);
}
const imageCache = new Map();
function fetchImage(url) {
  if (!imageCache.has(url)) imageCache.set(url, imageSlot(async () => Buffer.from(await (await get(url, 'image/*')).arrayBuffer())));
  return imageCache.get(url);
}

function imageExt(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.slice(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.slice(4, 12).toString('latin1').startsWith('ftypavif')) return 'avif';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  return null;
}

const decodeEntities = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/g, '/').replace(/&#39;/g, "'");
const slug = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).replace(/-$/, '');

function cleanUrl(raw) {
  const u = new URL(raw);
  for (const k of [...u.searchParams.keys()]) if (/^utm_|^queryID$|^index$/.test(k)) u.searchParams.delete(k);
  return u.toString();
}

function jsonLdProducts(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)) {
    let doc;
    try { doc = JSON.parse(m[1]); } catch { continue; }
    for (const d of [].concat(doc, doc['@graph'] || [])) if (d && d['@type'] === 'Product') out.push(d);
  }
  return out;
}
const ldImages = p => [].concat(p.image || []).map(i => (typeof i === 'string' ? i : i && (i.url || i.contentUrl))).filter(Boolean);

// ---- Retailer scrapers: each returns { title, photos: [{ url, kind, caption }] } ----

// Room & Board (Next.js): configured product render + detail close-ups + room scenes, served from Scene7.
function roomAndBoard(html, pageUrl) {
  const ld = jsonLdProducts(html)[0];
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  const model = nd ? JSON.parse(nd[1]).props?.pageProps?.productPageStore?.productPageModel : null;
  const group = model?.productGroup || {};
  const photos = [];
  // Neither render source reliably shows the URL's CHAR_* configuration: the JSON-LD image does for case goods
  // (e.g. Hudson nightstand), the override's default product does for upholstery (e.g. Eos fabric). If every
  // CHAR code appears in the JSON-LD render it's the right one; otherwise keep both, the second as product-alt.
  // (model.defaultProduct is the collection's default piece, often a different size, so it's not used.)
  const ldRender = ld ? ldImages(ld)[0] : null;
  const altRender = model?.configurationOverride?.defaultProduct?.imageData?.imageUrl;
  const codes = [...new URL(pageUrl).searchParams].filter(([k]) => k.startsWith('CHAR_')).map(([, v]) => v);
  const ldMatches = ldRender && codes.length && codes.every(c => ldRender.includes(c));
  const renders = [ldRender, ldMatches ? null : altRender].filter(Boolean);
  for (const [i, r] of renders.entries()) {
    // Composite/render URLs repeat query keys (layer=, src=), so edit the string rather than URLSearchParams.
    // Scene7 refuses anything over SCENE7_MAX on a side (scl=1 403s for large renders), so ask for a bounded box.
    const bare = r.replace(/([?&])scl=[^&]*(&|$)/, '$1').replace(/[?&]$/, '');
    const url = bare + (bare.includes('?') ? '&' : '?') + `wid=${SCENE7_MAX}&hei=${SCENE7_MAX}&fit=constrain`;
    photos.push({ url, kind: i ? 'product-alt' : 'product', caption: ld?.name || model?.defaultProduct?.detailTitle });
  }
  const scene7 = (media, kind) => {
    for (const m of media || []) {
      if (m.type !== 'IMAGE' || !m.image?.src) continue;
      const src = m.image.src;
      if (/^https?:/.test(src)) { photos.push({ url: src, kind, caption: m.caption || m.image.altText, alt: m.image.altText }); continue; }
      // The listed width isn't always what Scene7 will serve (some assets 403 above their real size), so step down.
      const base = SCENE7 + encodeURIComponent(src);
      const w = Math.min(m.image.width || SCENE7_MAX, SCENE7_MAX);
      const fallbacks = [2000, 1200].filter(x => x < w).map(x => `${base}?wid=${x}&qlt=90`);
      photos.push({ url: `${base}?wid=${w}&qlt=90`, fallbacks, kind, caption: m.caption || m.image.altText, alt: m.image.altText });
    }
  };
  scene7(group.dimensionMediaSet, 'dimensions');
  scene7(group.detailMediaSet, 'detail');
  scene7(group.environmentMediaSet, 'room');
  return { title: ld?.name || group.name, photos };
}

// Article: gallery images all live under cdn-images.article.com/products/SKU<id>/; the bare URL is the original.
function article(html, pageUrl) {
  const ld = jsonLdProducts(html)[0];
  const sku = (ld?.sku || `SKU${(pageUrl.match(/\/product\/(\d+)/) || [])[1]}`).replace(/^(?!SKU)/, 'SKU');
  const re = new RegExp(`https://cdn-images\\.article\\.com/products/${sku}/[^"'\\s?)\\\\]+\\.(?:jpe?g|png|webp)`, 'gi');
  const seen = new Set();
  const photos = [];
  for (const m of decodeEntities(html).matchAll(re)) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    photos.push({ url: m[0], kind: photos.length ? 'gallery' : 'product', caption: ld?.name });
  }
  return { title: ld?.name, photos };
}

// Anything else: JSON-LD product images, then og:image.
function generic(html, pageUrl) {
  const ld = jsonLdProducts(html)[0];
  const photos = (ld ? ldImages(ld) : []).map(url => ({ url, kind: 'product', caption: ld.name }));
  for (const m of html.matchAll(/<meta[^>]+property="og:image(?::secure_url)?"[^>]+content="([^"]+)"/g)) {
    photos.push({ url: decodeEntities(m[1]), kind: 'product', caption: ld?.name });
  }
  return { title: ld?.name, photos: photos.map(p => ({ ...p, url: new URL(p.url, pageUrl).toString() })) };
}

function scraperFor(url) {
  const host = new URL(url).hostname;
  if (/(^|\.)roomandboard\.com$/.test(host)) return roomAndBoard;
  if (/(^|\.)article\.com$/.test(host)) return article;
  return generic;
}

// ---- Main ----
async function readManifest(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf8')); } catch { return null; }
}

async function processProduct(rel) {
  const doc = JSON.parse(await fsp.readFile(path.join(DATA_DIR, rel), 'utf8'));
  const meta = doc.metadata || {};
  const rawUrl = meta.source_variant_url || meta.product_url;
  const name = doc.furniture?.name || rel;
  if (!rawUrl) return { rel, name, error: 'no metadata.product_url' };
  const pageUrl = cleanUrl(rawUrl);
  const dir = path.join(OUT, rel.replace(/\.json$/i, ''));

  const html = await fetchPage(pageUrl);
  const { title, photos: found } = scraperFor(pageUrl)(html, pageUrl);
  const seen = new Set();
  const photos = found.filter(p => !seen.has(p.url) && seen.add(p.url));
  if (!photos.length) return { rel, name, error: `no photos found on ${pageUrl}` };

  const previous = force ? null : await readManifest(dir);
  const reuse = new Map((previous?.photos || []).map(p => [p.url, p.file]));
  await fsp.mkdir(dir, { recursive: true });

  const width = Math.max(2, String(photos.length).length);
  // Download in parallel, then write in page order so duplicate detection keeps the earliest copy.
  const fetched = await Promise.all(photos.map(async p => {
    const old = reuse.get(p.url);
    if (old && fs.existsSync(path.join(dir, old))) return { p, old, buf: await fsp.readFile(path.join(dir, old)) };
    const urls = [p.url, ...(p.fallbacks || [])];
    for (const [j, u] of urls.entries()) {
      try { return { p, buf: await fetchImage(u) }; }
      catch (err) { if (j === urls.length - 1) return { p, error: err.message }; }
    }
  }));
  const hashes = new Set();
  const results = [];
  for (const [i, { p, old, buf, error }] of fetched.entries()) {
    if (error) { results.push({ ...p, error }); continue; }
    const ext = imageExt(buf);
    if (!ext) { results.push({ ...p, error: `not an image (${buf.length} bytes)` }); continue; }
    // Different URLs sometimes serve the same bytes (e.g. both Room & Board renders).
    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    if (hashes.has(hash)) continue;
    hashes.add(hash);
    if (old) { results.push({ ...p, file: old, skipped: true }); continue; }
    const tag = /^(product|gallery)/.test(p.kind) ? '' : slug(p.caption);
    const file = `${String(i + 1).padStart(width, '0')}-${p.kind}${tag ? '-' + tag : ''}.${ext}`;
    await fsp.writeFile(path.join(dir, file), buf);
    results.push({ ...p, file });
  }

  const ok = results.filter(r => r.file);
  // Drop photos an earlier run saved that the page no longer lists (only files our own manifest recorded).
  const keep = new Set(ok.map(r => r.file));
  for (const p of (await readManifest(dir))?.photos || []) {
    if (p.file && !keep.has(p.file) && path.basename(p.file) === p.file) await fsp.rm(path.join(dir, p.file), { force: true });
  }
  await fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify({
    product_file: rel,
    name,
    page_url: pageUrl,
    page_title: title || null,
    retrieved: new Date().toISOString(),
    photos: ok.map(({ file, kind, caption, alt, url }) => ({ file, kind, caption: caption || null, ...(alt && alt !== caption ? { alt } : {}), url })),
  }, null, 2) + '\n');

  return {
    rel, name, title, dir,
    downloaded: ok.filter(r => !r.skipped).length,
    skipped: ok.filter(r => r.skipped).length,
    failed: results.filter(r => r.error),
  };
}

(async () => {
  // Absolute paths, not cwd-relative: the data project usually lives outside this repo.
  console.log(`Reading products from ${DATA_DIR}`);
  console.log(`Saving photos to ${OUT}`);
  let products = [];
  for (const d of PRODUCT_DIRS) products.push(...await listJson(d));
  if (filters.length) products = products.filter(rel => filters.some(f => rel.toLowerCase().includes(f.toLowerCase())));
  if (!products.length) { console.error('No product files matched.'); process.exit(1); }

  console.log(`Fetching photos for ${products.length} product(s)`);
  const started = Date.now();
  let failures = 0;
  await Promise.all(products.map(async rel => {
    let r;
    try { r = await processProduct(rel); } catch (err) { r = { rel, error: err.message }; }
    if (r.error) { failures++; console.log(`  ✗ ${rel}: ${r.error}`); return; }
    const extra = [r.skipped && `${r.skipped} already had`, r.failed.length && `${r.failed.length} failed`].filter(Boolean).join(', ');
    console.log(`  ✓ ${rel}: ${r.downloaded} new${extra ? ` (${extra})` : ''}`);
    // Collection-level URLs can land on a different size/colour than the file describes.
    if (r.title && r.name && slug(r.title) !== slug(r.name)) console.log(`      page shows "${r.title}", file is "${r.name}"`);
    for (const f of r.failed) { failures++; console.log(`      ✗ ${f.kind} ${f.url}: ${f.error}`); }
  }));
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  if (failures) process.exitCode = 1;
})();