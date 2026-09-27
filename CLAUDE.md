# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, dependency-free tool for laying out bedroom furniture on a 2D floor plan. There is no bundler, lint, or test setup (`--build` only bakes data into a standalone page) — just Node (>=20) and a few source files. The 3D view loads three.js from jsdelivr, so it needs internet access.

**This repo is only the program.** The room and furniture files are a separate project, named on the command line at startup (this working copy uses `C:\git\bedroom-data`, via the `DATA_DIR` user env var):

```
node src/server.js <data-dir> [--open]       # or: npm start -- <data-dir>
npm start        # node src/server.js --open  (serves and opens the browser)
npm run serve    # node src/server.js         (no browser)
npm run build    # node src/server.js --build (write <output-dir>/furniture-layout.html, standalone, no server needed)
npm run photos   # node src/fetch-photos.js [filter...] [--data dir] [--force] [--out dir]
```

The data dir comes from the first positional argument or `-d`/`--data`, else `$DATA_DIR`, else `../data` next to the program; command-line options win over the environment. A missing data dir is fatal (exit 1 with usage) rather than an empty room. Pointing at a data *project* root works too: if the folder has no `room_layout.json` but its `data/` subfolder does, `resolveDataDir` descends into it (both `server.js` and `fetch-photos.js`).

Generated files go to `-o`/`--output`, else `$OUTPUT_DIR`, else `defaultOutputDir()`: the sibling `output/` of a data folder literally named `data`, otherwise `<data-dir>/output`. That covers placements and (via `--out`'s default) downloaded photos. `PORT` (default 3000) and `HOST` (default 127.0.0.1) are env-only. `node src/server.js --help` prints all of it.

```
src/      the whole program: server.js, fetch-photos.js, furniture-layout.html, room3d.html
```

A data project looks like this (`data/` + `output/`, the layout `defaultOutputDir` expects):

```
<project>/data/     input: room_layout.json, material_colors.json, furniture/, rugs/
<project>/output/   generated, git-ignored: furniture_placements.json, photos/
```

## Architecture

- **`src/server.js`** — plain `http` server. Serves `furniture-layout.html`, serves `room3d.html`, returns all project JSON in one call (`GET /api/project` → `{ dataDir, files: [{ path, text }] }`: `room_layout.json`, `material_colors.json` and every `.json` under `furniture/` and `rugs/` from `DATA_DIR`, plus `furniture_placements.json` from `OUTPUT_DIR`). Paths are sent relative to the data dir (e.g. `furniture/room_and_board/hudson_dresser.json`), and the placements file is sent under its bare name, so the client doesn't need to know about the folder layout; `dataDir` is the resolved absolute path, used only in the client's "not found" message (`state.dataDir`). The server also writes placements (`PUT`/`POST /api/placements` → `OUTPUT_DIR`, which is created if it's missing; POST exists for `navigator.sendBeacon` on unload) and pushes SSE on `GET /api/events`. A recursive `fs.watch` on `DATA_DIR` broadcasts `change` when the room, colors, furniture or rug files change. A second watch on `src/` broadcasts `page` when either HTML file changes, and both pages reload themselves. `OUTPUT_DIR` isn't watched, so writes to `furniture_placements.json` are intentionally *not* broadcast.
- **Standalone build** (`server.js --build`) — resolves `DATA_DIR`/`OUTPUT_DIR` like the server, then writes `<OUTPUT_DIR>/furniture-layout.html` instead of listening: the layout page with `window.FURNITURE_LAYOUT_EMBEDDED = { built, dataDir, files, room3d }` injected before `</head>` (`files` is exactly what `/api/project` returns; `room3d` is the 3D page's text with `window.FURNITURE_LAYOUT_STANDALONE = true` injected; JSON has `<` escaped). The page works from `file://`: `initStandalone()` loads `EMBEDDED.files`, edits save to localStorage (`furnitureLayout.standalone.placements`, `{ base, saved, text }`, where `base` hashes the baked-in placements so a rebuild with different placements wins over older browser edits), and the Project panel swaps **Reload files** for **Download placements** / **Reset to built layout**. The 3D popup is opened from a blob: URL and fed with `postMessage` between the two windows rather than the BroadcastChannel, which isn't dependable under `file://`.
- **`src/furniture-layout.html`** — the entire client (HTML + CSS + one inline `<script>`, SVG rendering, no framework). The server sends raw file text; all parsing/validation happens client-side in `parseRoom` / `parseFurniture` / `loadProject`. Edits are debounced (`commit()`) and saved through the server; view prefs (snap, grid, rail widths, collapsed panels/groups, ledger open) go to `localStorage`.
- **`src/room3d.html`** — walk-through 3D view (three.js + `PointerLockControls`, one inline module), opened as a popup by the **3D view** button. It has no data access of its own: the layout page posts the whole scene (`{ type: 'scene', room, colors, items }`, items carry their raw file as `doc`) on the `furniture-layout-3d` BroadcastChannel after every `refreshAll` / `refreshMoving` (throttled by a timer, not rAF, so it works from a background tab) and whenever the popup sends `hello`. All layout tabs share that channel, so scenes carry `source` (the posting tab's id, kept in `sessionStorage`); the popup is opened as `room3d.html?source=<id>`, ignores scenes from other tabs, and only that tab answers its `hello` — otherwise a stale tab (e.g. an old one left by `--open`) snaps the 3D view back to its old layout. Shapes are built per type in `buildPiece` (bed / case goods / chair / rug / box) from `furniture.dimensions` and optional `geometry.*` fields. `window.view3d` exposes `{ THREE, scene, camera, renderer }` for poking at it from DevTools.
- **`src/fetch-photos.js`** — standalone CLI, not used by the app. For each product file in `DATA_DIR` it scrapes `metadata.source_variant_url` (else `product_url`) and saves the photos to `<output-dir>/photos/<product path minus .json>/` (`--out` overrides that folder and is resolved against the current directory), named `NN-<kind>[-caption].<ext>` (git-ignored), plus a `sources.json` with each photo's URL and caption. Kinds: `product` (the configured render), `product-alt`, `detail`, `dimensions`, `room` (Room & Board, from `__NEXT_DATA__` media sets via Scene7, which caps at 4000px and serves WebP), `gallery` (Article, everything under `cdn-images.article.com/products/SKU<id>/`); other sites fall back to JSON-LD / `og:image`. Re-runs reuse files already on disk by URL and prune ones the page no longer lists. It warns when the page's product title differs from the file's `furniture.name`, which usually means a collection URL landed on another size or colour.

## Data files

All input lives in the data dir (see above). The paths below are relative to it.

- **`room_layout.json`** — room `width`/`length` (with `*_feet` fallbacks), `openings` (windows/doorways) given by `start`/`end` points on a wall. Only a southwest origin with x = east, y = north is supported. Doorways/entrances are drawn as plain openings (no door leaf in 2D or 3D, no clearance check). Optional `colors` (`walls.{north,south,east,west}`, `ceiling`, `floor`) names surface colors for the 3D view; the names are looked up in `material_colors.json` `materials`, falling back to `defaults.wall/ceiling/floor`.
- **`furniture/<vendor>/<item>.json`** and **`rugs/<size>/<item>.json`** (e.g. `rugs/9x12/`) — one file per product, same format. Everything under `rugs/` is a rug (drawn under furniture, exempt from overlap checks against furniture) and is listed in its own Rugs section, grouped by size folder then manufacturer. The client uses `furniture.dimensions` (`width` × `depth`, or `width` × `length` for rugs), optional `furniture.size` (appended to plan/ledger labels to tell variants apart), optional `furniture.shape: "round"` (drawn as an ellipse inscribed in width × depth in the plan and as a tub chair in the 3D view; its ellipse is the footprint everywhere — overlaps, walls, window sill and snapping — via `outline` / `halfExtents`, so rotating it changes nothing), `furniture.type` (drives default placement: beds → west wall, dressers/bookcases → east wall), `manufacturer` (list grouping), `metadata.price.configured_price`, optional `selected: true` (+ optional `quantity`) for a non-zero starting count, and `units` (inches/ft/cm/mm/m all accepted). Everything else (materials, construction, notes) is informational. Files are often *alternatives* for the same spot, so each file is a *product* whose count starts at 0; the list's −/+ stepper sets how many *pieces* of it are in the room.
- **`material_colors.json`** — `materials`: material/finish name → hex (case-insensitive), `defaults`: fallback colors for parts (wood, upholstery, metal, rug, mattress, floor, wall…). The 3D view resolves each part's color from the furniture file's `materials` (body: `case.color`/`case.wood`/`wood.species`/`wood_stain`/`upholstery` fabric+color/`color`; plus `base`, `top`, `hardware`) — first name found in the map wins; names not in the map are listed in the 3D HUD. Add new materials here rather than putting hex values in furniture files.
- **`<output-dir>/furniture_placements.json`** — generated output; do not hand-maintain, and don't write to it when testing (point `OUTPUT_DIR` at a scratch folder instead). Keyed by piece id: the first piece of a product is its base id = path under `furniture/` or `rugs/` minus `.json` (e.g. `room_and_board/hudson_dresser`, `9x12/nomad_9x12_olive_rug`), extra pieces are `<base>#2`, `<base>#3`… (kept contiguous; removing a piece renumbers the rest). On load a product's count = how many pieces it has in `placements`. Positions are feet-inches strings locating each piece's **back-left floor corner** in room coordinates; `rotation` is degrees clockwise from above, 0 = front faces north. `counts` and `not_placed` (products with 0 pieces) are informational. Moving a file to another folder is safe: on load an unknown saved id is adopted by the single product with the same file name. Placements for files that aren't loaded (renamed, or the server can't see them) are kept in `state.orphans` and written back unchanged rather than dropped.

## Coordinate gotcha

Internally the client stores each piece by its **center** in **SVG screen coordinates (y down)**; room y = `room.length - screenY`. Front of a piece is local −y. Conversion to/from the file format goes through `roomOrigin` / `setFromRoomOrigin` — use those rather than converting by hand.

The 3D view uses the same screen coordinates in inches: three.js `x` = screen x (east), `z` = screen y (south), `y` up; each piece is a group at its center with `rotation.y = -rot` in radians, local front = −z.
