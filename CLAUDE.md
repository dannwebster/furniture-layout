# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, dependency-free tool for laying out bedroom furniture on a 2D floor plan. There is no build, lint, or test setup — just Node (>=20) and three source files. The 3D view loads three.js from jsdelivr, so it needs internet access.

```
npm start        # node server.js --open  (serves and opens the browser)
npm run serve    # node server.js         (no browser)
```

`PORT` (default 3000) and `HOST` (default 127.0.0.1) env vars override the listen address.

## Architecture

- **`server.js`** — plain `http` server. Serves `furniture-layout.html`, serves `room3d.html`, returns all project JSON in one call (`GET /api/project` → `{ files: [{ path, text }] }`: `room_layout.json`, `furniture_placements.json`, `material_colors.json`, and every `.json` under `furniture/` and `rugs/`), writes placements (`PUT`/`POST /api/placements`; POST exists for `navigator.sendBeacon` on unload), and pushes SSE on `GET /api/events`. A recursive `fs.watch` broadcasts `change` when the room, colors, furniture or rug files change and `page` when either HTML file changes (both pages reload themselves). Writes to `furniture_placements.json` are intentionally *not* broadcast.
- **`furniture-layout.html`** — the entire client (HTML + CSS + one inline `<script>`, SVG rendering, no framework). The server sends raw file text; all parsing/validation happens client-side in `parseRoom` / `parseFurniture` / `loadProject`. Edits are debounced (`commit()`) and saved through the server; view prefs (snap, grid, rail widths, collapsed panels/groups, ledger open) go to `localStorage`.
- **`room3d.html`** — walk-through 3D view (three.js + `PointerLockControls`, one inline module), opened as a popup by the **3D view** button. It has no data access of its own: the layout page posts the whole scene (`{ type: 'scene', room, colors, items }`, items carry their raw file as `doc`) on the `furniture-layout-3d` BroadcastChannel after every `refreshAll` / `refreshMoving` (throttled by a timer, not rAF, so it works from a background tab) and whenever the popup sends `hello`. Shapes are built per type in `buildPiece` (bed / case goods / chair / rug / box) from `furniture.dimensions` and optional `geometry.*` fields. `window.view3d` exposes `{ THREE, scene, camera, renderer }` for poking at it from DevTools.

## Data files

- **`room_layout.json`** — room `width`/`length` (with `*_feet` fallbacks), `openings` (windows/doorways) given by `start`/`end` points on a wall. Only a southwest origin with x = east, y = north is supported. Doorways/entrances are drawn as plain openings (no door leaf in 2D or 3D, no clearance check).
- **`furniture/<vendor>/<item>.json`** and **`rugs/<size>/<item>.json`** (e.g. `rugs/9x12/`) — one file per product, same format. Everything under `rugs/` is a rug (drawn under furniture, exempt from overlap and doorway checks) and is listed in its own Rugs section, grouped by size folder then manufacturer. The client uses `furniture.dimensions` (`width` × `depth`, or `width` × `length` for rugs), optional `furniture.size` (appended to plan/ledger labels to tell variants apart), optional `furniture.shape: "round"` (drawn as an ellipse inscribed in width × depth in the plan and as a tub chair in the 3D view; overlap checks still use the rectangle), `furniture.type` (drives default placement: beds → west wall, dressers/bookcases → east wall), `manufacturer` (list grouping), `metadata.price.configured_price`, optional `selected: true` (+ optional `quantity`) for a non-zero starting count, and `units` (inches/ft/cm/mm/m all accepted). Everything else (materials, construction, notes) is informational. Files are often *alternatives* for the same spot, so each file is a *product* whose count starts at 0; the list's −/+ stepper sets how many *pieces* of it are in the room.
- **`material_colors.json`** — `materials`: material/finish name → hex (case-insensitive), `defaults`: fallback colors for parts (wood, upholstery, metal, rug, mattress, floor, wall…). The 3D view resolves each part's color from the furniture file's `materials` (body: `case.color`/`case.wood`/`wood.species`/`wood_stain`/`upholstery` fabric+color/`color`; plus `base`, `top`, `hardware`) — first name found in the map wins; names not in the map are listed in the 3D HUD. Add new materials here rather than putting hex values in furniture files.
- **`furniture_placements.json`** — generated output; do not hand-maintain, and don't write to it when testing (run the server from a scratch copy of the project instead). Keyed by piece id: the first piece of a product is its base id = path under `furniture/` or `rugs/` minus `.json` (e.g. `room_and_board/hudson_dresser`, `9x12/nomad_9x12_olive_rug`), extra pieces are `<base>#2`, `<base>#3`… (kept contiguous; removing a piece renumbers the rest). On load a product's count = how many pieces it has in `placements`. Positions are feet-inches strings locating each piece's **back-left floor corner** in room coordinates; `rotation` is degrees clockwise from above, 0 = front faces north. `counts` and `not_placed` (products with 0 pieces) are informational. Moving a file to another folder is safe: on load an unknown saved id is adopted by the single product with the same file name. Placements for files that aren't loaded (renamed, or the server can't see them) are kept in `state.orphans` and written back unchanged rather than dropped.

## Coordinate gotcha

Internally the client stores each piece by its **center** in **SVG screen coordinates (y down)**; room y = `room.length - screenY`. Front of a piece is local −y. Conversion to/from the file format goes through `roomOrigin` / `setFromRoomOrigin` — use those rather than converting by hand.

The 3D view uses the same screen coordinates in inches: three.js `x` = screen x (east), `z` = screen y (south), `y` up; each piece is a group at its center with `rotation.y = -rot` in radians, local front = −z.
