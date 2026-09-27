// Turn a point of view in the 3D walk-through into a photograph of the room.
//
// The 3D page sends its current camera, a flat-shaded render of exactly what it can see (the geometry
// pass), and what it measured about each piece in frame. From that this builds a photographic brief,
// hands it to an image model together with the geometry pass and the real products' catalogue photos,
// and saves the result under <output>/renders/render-<timestamp>/.
//
// The geometry pass carries the spatial truth — the image model is told to keep the camera, the walls
// and every footprint exactly as drawn — and the product photos carry appearance only. Claude can
// rewrite the brief first and check the returned photo against the geometry afterwards; both are
// optional and neither invents or drops a piece.
//
// ESM because two of the three SDKs are, and it's imported on demand so nothing loads until the
// first render.
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_REFS = 6;                            // reference photos per request, after the geometry pass
const MAX_REF_BYTES = 12 * 1024 * 1024;        // scraped renders reach 4000px; don't ship all of them
// Best appearance reference first. "dimensions" is a line drawing, so it never helps here.
const KIND_ORDER = ['product', 'product-alt', 'room', 'gallery', 'detail'];
const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const ASPECTS = [[1, 1], [2, 3], [3, 2], [3, 4], [4, 3], [4, 5], [5, 4], [9, 16], [16, 9]];
const COMPASS = ['north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east',
  'south-east', 'south-south-east', 'south', 'south-south-west', 'south-west', 'west-south-west',
  'west', 'west-north-west', 'north-west', 'north-north-west'];

// ---- Formatting ----
// ISO-8601 UTC with the time's colons (not allowed in Windows file names) as hyphens: 2026-09-26T14-30-12Z.
const stamp = () => new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
const round = (n, places = 0) => Number(Number(n).toFixed(places));

// Inches as people say them: 6 ft 1 in, 11 in, 9 ft.
function ft(inches) {
  const total = Math.round(Number(inches) || 0);
  const feet = Math.floor(Math.abs(total) / 12), rest = Math.abs(total) % 12;
  const sign = total < 0 ? '-' : '';
  if (!feet) return `${sign}${rest} in`;
  return rest ? `${sign}${feet} ft ${rest} in` : `${sign}${feet} ft`;
}
const inch = n => `${round(n, 1)} in`;
const compass = yawDeg => COMPASS[Math.round((((yawDeg % 360) + 360) % 360) / 22.5) % 16];

// Where in the frame, from the mask pass's screen box (0..1, y down).
function framePosition(box) {
  if (!box) return null;
  const x = (box.x0 + box.x1) / 2, y = (box.y0 + box.y1) / 2;
  const across = x < 0.34 ? 'left' : x > 0.66 ? 'right' : 'centre';
  const down = y < 0.34 ? 'upper' : y > 0.66 ? 'lower' : 'middle';
  return across === 'centre' && down === 'middle' ? 'dead centre' : `${down} ${across}`;
}

function bearingWords(deg) {
  const d = round(Math.abs(deg));
  if (d <= 2) return 'straight ahead';
  return `${d} degree${d === 1 ? '' : 's'} ${deg < 0 ? 'left' : 'right'} of the view axis`;
}

// ---- Material names ----
// Same idea as the 3D view's colorsFor(): read whatever the vendor's file happens to use, then look
// the name up in material_colors.json so the brief can name a colour as well as a material.
function materialWords(doc, palette) {
  const m = (doc && doc.materials) || {};
  const hex = name => {
    const key = String(name || '').trim().toLowerCase();
    return key && palette.has(key) ? ` (${palette.get(key)})` : '';
  };
  const named = (name, suffix = '') => (name ? `${name}${hex(name)}${suffix}` : null);
  const fiber = m.fiber_content && Object.entries(m.fiber_content)
    .map(([k, v]) => `${v}% ${k.replace(/_percent$/, '')}`).join(', ');
  // Material and colour first, then how it's made, then the trimmings — the order a photographer
  // would care about.
  const parts = [
    named(m.case?.wood || m.wood?.species || m.wood_stain || m.wood?.color),
    m.upholstery ? named([m.upholstery.fabric, m.upholstery.color].filter(Boolean).join(' '), ' upholstery') : null,
    named(m.color),
    fiber || null,
    doc?.construction?.method || null,
    m.case?.finish || m.finish ? `${m.case?.finish || m.finish} finish` : null,
    m.base && (m.base.wood || m.base.style) ? `${named(m.base.wood) || m.base.style} base` : null,
    m.hardware?.material ? `${m.hardware.material} hardware` : null,
  ];
  return parts.filter(Boolean).join(', ');
}

function paletteOf(colorsDoc) {
  const map = new Map();
  const materials = colorsDoc && colorsDoc.materials;
  if (materials && typeof materials === 'object') {
    for (const [k, v] of Object.entries(materials)) map.set(String(k).trim().toLowerCase(), String(v));
  }
  return map;
}

// ---- Reference photos ----
const mimeOf = file => MIME_BY_EXT[path.extname(file).toLowerCase()] || null;

// The photos fetch-photos.js saved for one product, best appearance reference first.
async function rankPhotos(dir, photos) {
  const sized = [];
  for (const p of photos) {
    let size = Infinity;
    try { size = (await fsp.stat(path.join(dir, p.file))).size; } catch { continue; }
    sized.push({ ...p, size });
  }
  const rank = p => { const i = KIND_ORDER.indexOf(p.kind); return i < 0 ? KIND_ORDER.length : i; };
  // Smallest file among equally good kinds: the 4000px renders cost tokens without adding detail.
  return sized.sort((a, b) => rank(a) - rank(b) || a.size - b.size);
}

// One product's photos serve all of its pieces, so the first piece in frame claims them.
async function collectReferences(items, ctx, perPiece) {
  const refs = [], missing = [], seen = new Set();
  let bytes = 0;
  for (const it of items) {
    if (refs.length >= MAX_REFS) break;
    const product = String(it.file || '').replace(/\.json$/i, '');
    if (!product || seen.has(product)) continue;
    seen.add(product);
    const dir = path.join(ctx.photosDir, ...product.split('/'));
    let manifest = null;
    try { manifest = JSON.parse(await fsp.readFile(path.join(dir, ctx.photoManifest), 'utf8')); }
    catch { /* no photos fetched for this product */ }
    // Only plain file names from the manifest, and only formats every image API takes.
    const usable = (manifest?.photos || []).filter(p => p?.file && path.basename(p.file) === p.file && mimeOf(p.file));
    if (!usable.length) { missing.push(it.label || it.name || product); continue; }
    for (const p of (await rankPhotos(dir, usable)).slice(0, perPiece)) {
      if (refs.length >= MAX_REFS) break;
      let data;
      try { data = await fsp.readFile(path.join(dir, p.file)); } catch { continue; }
      if (bytes + data.length > MAX_REF_BYTES) break;
      bytes += data.length;
      refs.push({
        item: it.id, product, file: p.file, kind: p.kind, caption: p.caption || null,
        url: p.url || null, pageConfig: manifest.page_config || null,
        // Where the server serves it from, the same relative form readPhotos() hands out.
        photo: ['photos', ...product.split('/'), p.file].map(encodeURIComponent).join('/'),
        bytes: data.length, mime: mimeOf(p.file), data,
      });
    }
  }
  return { refs, missing };
}

// ---- The brief ----
function roomLines(room, palette) {
  const color = name => (name ? `${name}${palette.has(String(name).toLowerCase()) ? ` (${palette.get(String(name).toLowerCase())})` : ''}` : null);
  const walls = room.colors?.walls || {};
  const names = ['north', 'south', 'east', 'west'].map(w => walls[w]).filter(Boolean);
  const allSame = names.length === 4 && new Set(names).size === 1;
  const lines = [
    `${ft(room.width)} east-west by ${ft(room.length)} north-south, ${ft(room.ceiling)} flat ceiling.`,
  ];
  if (allSame) lines.push(`Walls: ${color(names[0])}, all four.`);
  else if (names.length) {
    lines.push('Walls: ' + ['north', 'south', 'east', 'west']
      .filter(w => walls[w]).map(w => `${w} ${color(walls[w])}`).join(', ') + '.');
  }
  const surfaces = [
    room.colors?.ceiling ? `Ceiling: ${color(room.colors.ceiling)}` : null,
    room.colors?.floor ? `Floor: ${color(room.colors.floor)}` : null,
  ].filter(Boolean);
  if (surfaces.length) lines.push(surfaces.join('. ') + '.');
  for (const o of room.openings || []) {
    const where = o.placement === 'centered' ? `centred on the ${o.wall} wall`
      : o.corner ? `at the ${o.corner} corner of the ${o.wall} wall` : `on the ${o.wall} wall`;
    const size = Number.isFinite(o.sill) && Number.isFinite(o.height)
      ? `, sill ${ft(o.sill)} above the floor, ${ft(o.height)} tall`
      : '';
    const leaf = o.type === 'window' ? '' : ', no door leaf';
    lines.push(`${o.type === 'window' ? 'Window' : 'Doorway'}: ${ft(o.width)} wide, ${where}${size}${leaf}.`);
  }
  return lines;
}

function itemLines(items, refsByItem, startIndex) {
  const lines = [];
  for (const [i, it] of items.entries()) {
    const dims = it.isRug
      ? `${inch(it.width)} by ${inch(it.depth)}`
      : `${inch(it.width)} wide, ${inch(it.depth)} deep, ${inch(it.height)} tall`;
    const bits = [
      `${i + startIndex}. ${it.label || it.name} — ${it.words || 'no material listed'}. ${dims}.`,
      `Centre ${ft(it.distanceIn)} from the camera, ${bearingWords(it.bearingDeg)}.`,
      it.facing ? `${it.facing}.` : null,
      Number.isFinite(it.coverage)
        ? `Fills about ${Math.max(1, Math.round(it.coverage * 100))}% of the frame, ${framePosition(it.screenBox) || 'in view'}.`
        : null,
    ];
    const ref = refsByItem.get(it.id);
    if (ref) {
      bits.push(`Appearance reference: image ${ref.imageIndex}` +
        (ref.pageConfig ? ` (shown configured as: ${ref.pageConfig})` : '') + '.');
    } else {
      bits.push('No photo available — follow the materials named above.');
    }
    lines.push('  ' + bits.filter(Boolean).join(' '));
  }
  return lines;
}

function buildPrompt({ request, images, refs, palette, docs }) {
  const { room, pov, options = {} } = request;
  const cam = pov.room || {};
  const refsByItem = new Map(refs.map(r => [r.item, r]));
  // Everything the mask pass could see, biggest first; the rest is named so it doesn't get invented.
  const decorate = it => ({ ...it, words: materialWords(docs.get(it.file), palette) });
  const visible = request.items.filter(it => it.visible).sort((a, b) => (b.coverage || 0) - (a.coverage || 0));
  const clear = visible.filter(it => (it.coverage || 0) >= 0.01).map(decorate);
  const slivers = visible.filter(it => (it.coverage || 0) < 0.01).map(decorate);
  const hidden = request.items.filter(it => !it.visible);

  const geometry = images.findIndex(i => i.role === 'geometry') + 1;
  const mask = images.findIndex(i => i.role === 'mask') + 1;
  const firstRef = images.findIndex(i => i.role === 'reference') + 1;

  const out = [
    'Photograph this bedroom from the exact viewpoint of the attached GEOMETRY image.',
    '',
    `IMAGE ${geometry} — GEOMETRY: an untextured 3D render of the room from the camera described below. It`,
    'defines the perspective, the framing, and the exact position, footprint, scale and orientation of',
    'every object. Reproduce it as a photograph: same camera, same walls, same window, same objects in',
    'the same places at the same sizes. Do not add, remove, move, resize or re-orient anything.',
    ...(options.decor ? [
      'The one exception is decor: dress the room with tasteful, restrained styling that suits its',
      'furniture and palette — a few plants, framed art on the walls, a lamp, books, a throw and cushions',
      'on the bed, a vase or tray on a surface. Keep it light and lived-in, never cluttered. Decor may sit',
      'on or against the listed pieces and hang on the walls, but it must not hide, replace or change any',
      'listed piece, cover the window or doorways, or add furniture. No people.',
    ] : [
      'Do not invent extra decor — no plants, art, lamps, books, throws, cushions or people beyond what is',
      'listed below.',
    ]),
  ];
  if (mask) {
    out.push('',
      `IMAGE ${mask} — SEGMENTATION KEY: the same view with each piece in a flat colour, to tell the masses`,
      'apart. It is a key, not a style: never reproduce its colours.');
  }
  if (firstRef) {
    out.push('',
      `IMAGE${images.length - firstRef ? `S ${firstRef}-${images.length}` : ` ${firstRef}`} — PRODUCT REFERENCES: catalogue photos of the real products. Use them only for`,
      'appearance: material, colour, wood grain, weave, upholstery texture, hardware, and the proportions',
      'of details. Ignore their backgrounds, their lighting, their camera angles and any props in them.');
  }
  out.push('', 'ROOM', ...roomLines(room, palette).map(l => '  ' + l));
  out.push('', 'CAMERA',
    `  ${ft(cam.fromWest)} from the west wall, ${ft(cam.fromSouth)} from the south wall, eye height ${ft(cam.eye)}.`,
    `  Looking ${compass(cam.yawDeg)} (${round(cam.yawDeg)} degrees clockwise from north), pitched ` +
      `${Math.abs(round(cam.pitchDeg))} degrees ${cam.pitchDeg <= 0 ? 'down' : 'up'}.`,
    `  Horizontal field of view ${round(cam.hfovDeg)} degrees, ${pov.width} by ${pov.height} pixels.`);
  if (clear.length) out.push('', 'IN FRAME, largest first', ...itemLines(clear, refsByItem, 1));
  if (slivers.length) out.push('', 'PARTLY HIDDEN OR FAR', ...itemLines(slivers, refsByItem, clear.length + 1));
  if (hidden.length) {
    out.push('', 'NOT IN FRAME — do not draw these',
      '  ' + hidden.map(it => it.label || it.name).join(', ') + '.');
  }
  out.push('', 'LIGHTING', '  ' + (options.lighting ||
    'Mid-afternoon daylight through the window, warm interior ambient, soft directional shadows.'));
  out.push('', 'STYLE', '  ' + (options.style ||
    'Straight architectural interior photograph, roughly 24 mm equivalent, deep focus, level horizon, ' +
    'no vignette, no lens distortion beyond the stated field of view, natural colour, no text or watermark.'));
  if (options.notes) out.push('', String(options.notes).trim());
  return out.join('\n') + '\n';
}

// ---- Claude: write the brief, and check the result ----
const PROMPT_SYSTEM = `You turn a structured description of a room into one prompt for an image-generation model, which will receive the same geometry render and product photos you are told about.

Rewrite the description as tight, concrete photographic direction. Rules, all of them absolute:
- Keep every measurement, colour, material, count, bearing, percentage and image number exactly as given.
- Never add an object, material, or piece of decor that is not listed. Never drop a listed piece.
- Keep the instruction that the geometry image fixes the camera, the room and the placement and size of everything, and keep the "do not draw" list.
Reply with the prompt text only: no preamble, no markdown, no commentary.`;

// With decor on, the brief itself asks for styling, so the rules make room for it instead of fighting it.
const PROMPT_SYSTEM_DECOR = PROMPT_SYSTEM.replace(
  '- Never add an object, material, or piece of decor that is not listed. Never drop a listed piece.',
  '- Never add furniture, or a material, that is not listed. Never drop a listed piece. Keep the instruction ' +
  'to add tasteful decor, and its limits, as given; do not name specific decor items the description does not.');

const AUDIT_SYSTEM = `You check a generated interior photograph against the untextured 3D render it was supposed to match.

The first image is the photograph, the second is the geometry it had to follow. Report only differences that matter for a furniture layout: a piece missing, added, moved, resized, re-oriented, or the wrong material; a window, doorway or wall in the wrong place; a camera that clearly moved.

One finding per line, plain text, most serious first, at most eight lines. If the photograph follows the geometry, reply with exactly: ok`;

const AUDIT_SYSTEM_DECOR = AUDIT_SYSTEM.replace('One finding per line',
  'Decor was requested: plants, art, lamps, books, textiles and small objects that are not in the geometry are expected — only report decor that hides or replaces a piece, covers a window or doorway, or is really extra furniture.\n\nOne finding per line');

async function claudeClient(env) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

const imageBlock = img => ({
  type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data.toString('base64') },
});

// Adaptive thinking can run long, so stream and take the final message.
async function claudeText({ env, model, system, content }) {
  const client = await claudeClient(env);
  const stream = client.messages.stream({
    model, max_tokens: 16000, thinking: { type: 'adaptive' }, system,
    messages: [{ role: 'user', content }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') return null;
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return text || null;
}

// ---- Image models ----
function nearestAspect(width, height) {
  const want = width / height;
  let best = ASPECTS[0];
  for (const a of ASPECTS) if (Math.abs(a[0] / a[1] - want) < Math.abs(best[0] / best[1] - want)) best = a;
  return `${best[0]}:${best[1]}`;
}

// The SDK's own retry is off: it re-sends one stored Request by cloning it per attempt, and a render
// once failed there with "TypeError: unusable" from Request.clone(), which hid whatever went wrong first
// (not reproduced locally: its retries survive 503s and dropped connections). Busy/overloaded answers
// (408, 429, 5xx) are retried here with a fresh call instead; anything else surfaces as it is.
const GEMINI_TRIES = 3;
const retryable = err => err?.status === 408 || err?.status === 429 || err?.status >= 500;

async function gemini({ model, prompt, images, pov, env }) {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const request = {
    model,
    input: [
      { type: 'text', text: prompt },
      ...images.map(i => ({ type: 'image', mime_type: i.mime, data: i.data.toString('base64') })),
    ],
    response_format: {
      // JPEG is the only output type this endpoint accepts ("Supported values: 'image/jpeg'"), which
      // is no loss for a photograph.
      type: 'image', mime_type: 'image/jpeg',
      aspect_ratio: nearestAspect(pov.width, pov.height),
      image_size: Math.max(pov.width, pov.height) > 1200 ? '2K' : '1K',
    },
  };
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await ai.interactions.create(request, { retries: { strategy: 'none' } });
      break;
    } catch (err) {
      if (attempt >= GEMINI_TRIES || !retryable(err)) throw err;
      const wait = 2000 * 2 ** (attempt - 1);
      console.warn(`${model}: ${err.status} ${String(err.message || '').slice(0, 200)}; retrying in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  const out = res.output_image;
  if (!out || !out.data) {
    throw new Error(`${model} returned no image${res.output_text ? `: ${res.output_text.slice(0, 300)}` : ''}`);
  }
  return {
    images: [{ mime: out.mime_type || 'image/jpeg', data: Buffer.from(out.data, 'base64') }],
    usage: res.usage || null,
  };
}

// Optional parameters a model has turned down ("The model 'X' does not support the 'Y' parameter."), so
// they're left out for it from then on. Image models differ (gpt-image-2.5-flare has no input_fidelity),
// and a 400 is refused before anything is generated, so dropping the parameter and retrying costs nothing.
const UNSUPPORTED = new Map(); // model → Set of parameter names
const OPTIONAL = ['quality', 'input_fidelity'];

async function openai({ model, prompt, images, pov, env }) {
  const mod = await import('openai');
  const client = new mod.default({ apiKey: env.OPENAI_API_KEY });
  const toFiles = () => Promise.all(images.map((img, i) =>
    mod.toFile(img.data, `${i + 1}-${img.role}${path.extname(img.file || '') || '.png'}`, { type: img.mime })));
  const optional = {
    quality: 'high',
    input_fidelity: 'high',   // keep the reference products looking like themselves, where the model offers it
  };
  const skip = UNSUPPORTED.get(model) || new Set();
  let res;
  for (;;) {
    const extra = Object.fromEntries(Object.entries(optional).filter(([k]) => !skip.has(k)));
    try {
      // Fresh file objects each try: an upload stream can only be read once.
      res = await client.images.edit({ model, image: await toFiles(), prompt, n: 1, size: `${pov.width}x${pov.height}`, ...extra });
      break;
    } catch (err) {
      const param = err?.status === 400 && /does not support the '([\w.]+)' parameter/i.exec(err.message || '')?.[1];
      if (!param || !OPTIONAL.includes(param) || skip.has(param)) throw err;
      skip.add(param);
      UNSUPPORTED.set(model, skip);
      console.warn(`${model} doesn't take ${param}; retrying without it`);
    }
  }
  const out = (res.data || []).filter(d => d.b64_json);
  if (!out.length) throw new Error(`${model} returned no image`);
  const mime = `image/${res.output_format || 'png'}`;
  return { images: out.map(d => ({ mime, data: Buffer.from(d.b64_json, 'base64') })), usage: res.usage || null };
}

const PROVIDERS = { gemini, openai };
const KEY_FOR = { gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY' };

// ---- What gets written beside the images ----
// Everything needed to explain a render later: the camera it was taken from, what was in frame and how
// much of it, which photos stood in for which piece, the models used, and how long each stage took.
function describe({ request, name, provider, model, promptModel, refs, missing, options, files, url, times, claudeUsed, audit, usage, error }) {
  const { pov } = request;
  return {
    name,
    created: new Date().toISOString(),
    provider, model,
    promptModel: claudeUsed || audit ? promptModel : null,
    error: error || null,
    size: { width: pov.width, height: pov.height, aspect: nearestAspect(pov.width, pov.height) },
    pov: { position: pov.position, quaternion: pov.quaternion, fov: pov.fov },
    camera: pov.room || null,
    room: request.room ? { width: request.room.width, length: request.room.length, ceiling: request.room.ceiling } : null,
    items: request.items.map(it => ({
      id: it.id, file: it.file, label: it.label, visible: !!it.visible,
      coverage: Number.isFinite(it.coverage) ? round(it.coverage, 4) : null,
      distanceIn: Number.isFinite(it.distanceIn) ? round(it.distanceIn) : null,
      bearingDeg: Number.isFinite(it.bearingDeg) ? round(it.bearingDeg) : null,
      facing: it.facing || null, screenBox: it.screenBox || null,
    })),
    references: refs.map(({ data, ...rest }) => rest),
    missingPhotos: missing,
    options: { ...options, provider },
    claudePrompt: !!claudeUsed,
    audit,
    files,
    urls: {
      pov: url(files.pov),
      mask: files.mask ? url(files.mask) : null,
      renders: files.renders.map(url),
    },
    usage: usage || null,
    times,
  };
}

// Written last and through a temp file, because /api/renders skips folders with no meta.json: a
// half-written one is never read.
async function saveMeta(ctx, dir, meta) {
  const text = JSON.stringify(meta, null, 2) + '\n';
  const tmp = await ctx.writeOutput(`${dir}/meta.json.tmp`, text);
  try {
    await fsp.rename(tmp, path.join(path.dirname(tmp), 'meta.json'));
  } catch {
    // Windows can refuse the rename while something holds the file; write in place instead.
    await ctx.writeOutput(`${dir}/meta.json`, text);
    await fsp.rm(tmp, { force: true });
  }
  return meta;
}

// ---- Entry point ----
function dataUrl(value, what, badRequest) {
  const m = /^data:([\w./+-]+);base64,(.*)$/s.exec(String(value || ''));
  if (!m) throw badRequest(`${what} must be a base64 data URL`);
  return { mime: m[1], data: Buffer.from(m[2], 'base64') };
}

export async function renderView(request, ctx) {
  const { env, badRequest, broadcast } = ctx;
  const options = request.options || {};
  if (!request.pov || !Number.isFinite(request.pov.width)) throw badRequest('missing pov');
  if (!Array.isArray(request.items) || !request.items.length) throw badRequest('missing items');
  const provider = options.provider || env.RENDER_PROVIDER || 'gemini';
  if (!PROVIDERS[provider]) throw badRequest(`unknown image provider "${provider}"`);
  const missingKey = name => badRequest(`${name} is not set — add it to a .env file in ${ctx.dataDir} or beside package.json`);
  // promptOnly stops after the brief, so it needs no image model and costs nothing.
  if (!options.promptOnly && !env[KEY_FOR[provider]]) throw missingKey(KEY_FOR[provider]);
  if ((options.claudePrompt || options.audit) && !env.ANTHROPIC_API_KEY) throw missingKey('ANTHROPIC_API_KEY');

  const name = `render-${stamp()}`;
  const dir = `${ctx.rendersSubdir}/${name}`;
  const url = file => [ctx.rendersSubdir, name, file].map(encodeURIComponent).join('/');
  const times = {};
  const clock = () => Date.now();
  const started = clock();

  const geometry = dataUrl(request.images?.beauty, 'images.beauty', badRequest);
  const maskImage = request.images?.mask ? dataUrl(request.images.mask, 'images.mask', badRequest) : null;

  // 1. Reference photos, richest-in-frame first.
  broadcast('render', { stage: 'references', name });
  let t = clock();
  const perPiece = Math.min(2, Math.max(1, Number(options.refsPerPiece) || 1));
  const inFrame = request.items.filter(it => it.visible).sort((a, b) => (b.coverage || 0) - (a.coverage || 0));
  const { refs, missing } = await collectReferences(inFrame, ctx, perPiece);
  times.references = clock() - t;

  const images = [{ role: 'geometry', ...geometry }];
  if (options.sendMask && maskImage) images.push({ role: 'mask', ...maskImage });
  for (const ref of refs) {
    images.push({ role: 'reference', mime: ref.mime, data: ref.data, file: ref.file });
    ref.imageIndex = images.length;
  }

  // 2. The brief: material names come from the product files themselves.
  broadcast('render', { stage: 'prompt', name });
  t = clock();
  const docs = new Map();
  for (const it of request.items) {
    if (!it.file || docs.has(it.file)) continue;
    try { docs.set(it.file, JSON.parse(await fsp.readFile(path.join(ctx.dataDir, it.file), 'utf8'))); }
    catch { docs.set(it.file, null); }
  }
  let colorsDoc = request.colors;
  try { colorsDoc = JSON.parse(await fsp.readFile(path.join(ctx.dataDir, 'material_colors.json'), 'utf8')); }
  catch { /* fall back to what the page sent */ }
  const draft = buildPrompt({ request, images, refs, palette: paletteOf(colorsDoc), docs });
  times.prompt = clock() - t;

  // 3. Optionally let Claude tighten it. A refusal or an error falls back to the draft.
  let final = draft, claudeUsed = false;
  if (options.claudePrompt) {
    broadcast('render', { stage: 'claude', name });
    t = clock();
    try {
      const text = await claudeText({
        env, model: ctx.promptModel, system: options.decor ? PROMPT_SYSTEM_DECOR : PROMPT_SYSTEM,
        content: [imageBlock(images[0]), { type: 'text', text: draft }],
      });
      if (text) { final = text.endsWith('\n') ? text : text + '\n'; claudeUsed = true; }
    } catch (err) {
      broadcast('render', { stage: 'claude-failed', name, error: err.message });
    }
    times.claude = clock() - t;
  }

  // 4. Save what the render was made from before making it, so a failed one can still be read.
  const files = { pov: 'pov.png', mask: null, renders: [], prompt: 'prompt.txt', meta: 'meta.json' };
  await ctx.writeOutput(`${dir}/pov.png`, geometry.data);
  if (maskImage) { files.mask = 'mask.png'; await ctx.writeOutput(`${dir}/mask.png`, maskImage.data); }
  await ctx.writeOutput(`${dir}/prompt.txt`, draft);
  if (claudeUsed) { files.promptClaude = 'prompt-claude.txt'; await ctx.writeOutput(`${dir}/prompt-claude.txt`, final); }

  // Stopping here is the point of promptOnly: the brief and both passes are on disk to read, export or
  // iterate on, with no image model involved.
  if (options.promptOnly) {
    times.total = clock() - started;
    const meta = await saveMeta(ctx, dir, describe({
      request, name, provider, model: null, promptModel: ctx.promptModel, refs, missing, options, files,
      url, times, claudeUsed, audit: null, usage: null, error: null,
    }));
    broadcast('render', { stage: 'saved', name, url: null });
    return meta;
  }

  // 5. The picture. A failure still leaves a meta.json saying what was attempted and why it failed.
  broadcast('render', { stage: 'generating', name, provider });
  t = clock();
  const model = options.model || ctx.models[provider];
  let result;
  try {
    result = await PROVIDERS[provider]({ model, prompt: final, images, pov: request.pov, env });
  } catch (err) {
    times.image = clock() - t;
    times.total = clock() - started;
    await saveMeta(ctx, dir, describe({
      request, name, provider, model, promptModel: ctx.promptModel, refs, missing, options, files, url,
      times, claudeUsed, audit: null, usage: null, error: err.message,
    }));
    broadcast('render', { stage: 'error', name, error: err.message });
    throw err;
  }
  times.image = clock() - t;
  // Named for what the model actually returned: providers differ on the format they'll emit.
  for (const [i, img] of result.images.entries()) {
    const file = `render${i ? `-${i + 1}` : ''}.${EXT_BY_MIME[img.mime] || 'png'}`;
    files.renders.push(file);
    await ctx.writeOutput(`${dir}/${file}`, img.data);
  }

  // 6. Optionally have Claude compare the photo with the geometry it had to follow.
  let audit = null;
  if (options.audit && files.renders.length) {
    broadcast('render', { stage: 'audit', name });
    t = clock();
    try {
      const text = await claudeText({
        env, model: ctx.promptModel, system: options.decor ? AUDIT_SYSTEM_DECOR : AUDIT_SYSTEM,
        content: [
          imageBlock({ mime: result.images[0].mime, data: result.images[0].data }),
          imageBlock(images[0]),
          { type: 'text', text: final },
        ],
      });
      audit = text && text.trim().toLowerCase() !== 'ok' ? text.split('\n').map(s => s.trim()).filter(Boolean) : [];
    } catch (err) {
      broadcast('render', { stage: 'audit-failed', name, error: err.message });
    }
    times.audit = clock() - t;
  }

  times.total = clock() - started;
  const meta = await saveMeta(ctx, dir, describe({
    request, name, provider, model, promptModel: ctx.promptModel, refs, missing, options, files, url,
    times, claudeUsed, audit, usage: result.usage, error: null,
  }));
  broadcast('render', { stage: 'saved', name, url: meta.urls.renders[0] || null });
  return meta;
}
