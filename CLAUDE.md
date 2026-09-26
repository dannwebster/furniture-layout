# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, dependency-free tool for laying out bedroom furniture on a 2D floor plan. There is no build, lint, or test setup — just Node (>=20) and two source files.

```
npm start        # node server.js --open  (serves and opens the browser)
npm run serve    # node server.js         (no browser)
```

`PORT` (default 3000) and `HOST` (default 127.0.0.1) env vars override the listen address.

## Architecture

- **`server.js`** — plain `http` server. Serves `furniture-layout.html`, returns all project JSON in one call (`GET /api/project` → `{ files: [{ path, text }] }`: `room_layout.json`, `furniture_placements.json`, and every `.json` under `furniture/`), writes placements (`PUT`/`POST /api/placements`; POST exists for `navigator.sendBeacon` on unload), and pushes SSE on `GET /api/events`. A recursive `fs.watch` broadcasts `change` when the room or furniture files change and `page` when the HTML changes (the page reloads itself). Writes to `furniture_placements.json` are intentionally *not* broadcast.
- **`furniture-layout.html`** — the entire client (HTML + CSS + one inline `<script>`, SVG rendering, no framework). The server sends raw file text; all parsing/validation happens client-side in `parseRoom` / `parseFurniture` / `loadProject`. Edits are debounced (`commit()`) and saved through the server; view prefs (snap, grid) go to `localStorage`.

## Data files

- **`room_layout.json`** — room `width`/`length` (with `*_feet` fallbacks), `openings` (windows/doors) given by `start`/`end` points on a wall. Only a southwest origin with x = east, y = north is supported.
- **`furniture/<vendor>/<item>.json`** — one file per product. The client uses `furniture.dimensions` (`width` × `depth`, or `width` × `length` for rugs), `furniture.type` (drives rug detection and default placement: beds → west wall, dressers/bookcases → east wall), `manufacturer` (list grouping), `metadata.price.configured_price`, optional `quantity` (expands to ids `path#1`, `path#2`…), optional `selected: true`, and `units` (inches/ft/cm/mm/m all accepted). Everything else (materials, construction, notes) is informational. Files are often *alternatives* for the same spot, so pieces start unincluded unless `selected` is true.
- **`furniture_placements.json`** — generated output; do not hand-maintain. Keyed by item id = path under `furniture/` minus `.json` (e.g. `room_and_board/hudson_dresser`). Positions are feet-inches strings locating each piece's **back-left floor corner** in room coordinates; `rotation` is degrees clockwise from above, 0 = front faces north. `not_placed` lists excluded ids. Renaming a furniture file changes its id and orphans its saved placement.

## Coordinate gotcha

Internally the client stores each piece by its **center** in **SVG screen coordinates (y down)**; room y = `room.length - screenY`. Front of a piece is local −y. Conversion to/from the file format goes through `roomOrigin` / `setFromRoomOrigin` — use those rather than converting by hand.
