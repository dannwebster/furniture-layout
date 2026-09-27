# furniture-layout

A local, dependency-free tool for laying out bedroom furniture on a 2D floor plan, with a walk-through 3D view. There is no bundler, lint, or test setup — just Node (>=20) and a few source files. The 3D view loads three.js from jsdelivr, so it needs internet access.

**This repo is only the program.** The room and furniture files live in a separate data project, named on the command line at startup.

## Usage

```
node src/server.js <data-dir> [--open]       # or: npm start -- <data-dir>
npm start        # node src/server.js --open  (serves and opens the browser)
npm run serve    # node src/server.js         (no browser)
npm run build    # node src/server.js --build (write <output-dir>/furniture-layout.html, standalone, no server needed)
npm run photos   # node src/fetch-photos.js [filter...] [--data dir] [--force] [--out dir]
```

`node src/server.js --help` prints all options.

### Where data comes from

The data dir is the first positional argument or `-d`/`--data`, else `$DATA_DIR`, else `../data` next to the program. Command-line options win over the environment. A missing data dir is fatal (exit 1 with usage). You can also point at a data *project* root: if the folder has no `room_layout.json` but its `data/` subfolder does, that subfolder is used.

### Where output goes

Generated files (placements, downloaded photos, the standalone build) go to `-o`/`--output`, else `$OUTPUT_DIR`, else:

- the sibling `output/` folder, if the data folder is literally named `data`;
- otherwise `<data-dir>/output`.

`PORT` (default 3000) and `HOST` (default 127.0.0.1) are set via environment only.

## Layout

```
src/      the whole program: server.js, fetch-photos.js, furniture-layout.html, room3d.html
```

A data project looks like this:

```
<project>/data/     input: room_layout.json, material_colors.json, furniture/, rugs/
<project>/output/   generated, git-ignored: furniture_placements.json, photos/
```

## How it works

- **`src/server.js`** — a plain `http` server. It serves the two pages, returns all project JSON in one call (`GET /api/project`), and saves placements (`PUT`/`POST /api/placements`, into the output dir). It pushes server-sent events on `GET /api/events`: `change` when room, color, furniture or rug files change, and `page` when either HTML file changes, so open pages reload themselves. Writes to the placements file are not broadcast.
- **`src/furniture-layout.html`** — the entire client: HTML, CSS and one inline script rendering SVG, no framework. The server sends raw file text; all parsing and validation happens in the browser. Edits are debounced and saved through the server; view preferences (snap, grid, panel widths, collapsed sections) are kept in `localStorage`.
- **`src/room3d.html`** — the walk-through 3D view (three.js + pointer-lock controls), opened as a popup by the **3D view** button. It has no data access of its own; the layout page sends it the whole scene over a `BroadcastChannel` whenever the layout changes. Each layout tab tags its scenes with its own id so a stale tab can't overwrite the view.
- **Standalone build** (`--build`) — writes `<output-dir>/furniture-layout.html` with all project data baked in. It works from `file://` with no server: edits are saved to `localStorage`, and the Project panel offers **Download placements** and **Reset to built layout** instead of **Reload files**. A rebuild with different placements takes precedence over older browser edits.
- **`src/fetch-photos.js`** — a standalone CLI, not used by the app. For each product file it scrapes the product page (`metadata.source_variant_url`, else `product_url`) and saves its photos to `<output-dir>/photos/<product path>/`, plus a `sources.json` listing each photo's URL and caption. Room & Board and Article pages get full image sets; other sites fall back to JSON-LD / `og:image`. Re-runs reuse files already downloaded and prune ones the page no longer lists, and it warns when the page's product title doesn't match the file's `furniture.name`.

## Data files

All paths below are relative to the data dir.

### `room_layout.json`

Room `width`/`length` (with `*_feet` fallbacks) and `openings` (windows and doorways), each given by `start`/`end` points on a wall. Only a southwest origin with x = east, y = north is supported. Doorways are drawn as plain openings (no door leaf, no clearance check). Optional `colors` (`walls.{north,south,east,west}`, `ceiling`, `floor`) names surface colors for the 3D view.

### `furniture/<vendor>/<item>.json` and `rugs/<size>/<item>.json`

One file per product, same format for both. Everything under `rugs/` is a rug: drawn under furniture, exempt from overlap checks against furniture, and listed in its own section grouped by size folder then manufacturer.

Fields the app uses:

| Field | Purpose |
|---|---|
| `furniture.dimensions` | `width` × `depth` (or `width` × `length` for rugs) |
| `furniture.size` | optional; appended to labels to tell variants apart |
| `furniture.shape: "round"` | optional; drawn as an ellipse in the plan and a tub chair in 3D, and used as the footprint for overlaps, walls and snapping |
| `furniture.type` | drives default placement: beds → west wall, dressers/bookcases → east wall |
| `manufacturer` | list grouping |
| `metadata.price.configured_price` | price shown in the ledger |
| `selected: true` (+ `quantity`) | optional non-zero starting count |
| `units` | inches, ft, cm, mm and m are all accepted |

Everything else (materials, construction, notes) is informational. Files are often *alternatives* for the same spot, so each file is a *product* whose count starts at 0; the list's −/+ stepper sets how many *pieces* of it are in the room.

### `material_colors.json`

`materials` maps material/finish names to hex colors (case-insensitive); `defaults` gives fallback colors for parts (wood, upholstery, metal, rug, mattress, floor, wall…). The 3D view looks up each part's color from the furniture file's `materials`, and lists names it couldn't find in the HUD. Add new materials here rather than putting hex values in furniture files.

### `<output-dir>/furniture_placements.json`

Generated output — don't edit it by hand, and don't write to it when testing (point `OUTPUT_DIR` at a scratch folder instead). It's keyed by piece id: the first piece of a product uses the file's path under `furniture/` or `rugs/` minus `.json` (e.g. `room_and_board/hudson_dresser`), extra pieces are `<id>#2`, `<id>#3`, and so on. Positions are feet-inches strings locating each piece's **back-left floor corner** in room coordinates; `rotation` is degrees clockwise from above, where 0 means the front faces north.

Moving a product file to another folder is safe: an unknown saved id is adopted by the single product with the same file name. Placements for files that aren't loaded are kept and written back unchanged rather than dropped.

## Coordinates

Internally the client stores each piece by its **center** in **SVG screen coordinates (y down)**, so room y = `room.length − screenY`, and the front of a piece is local −y. Conversion to and from the file format goes through `roomOrigin` / `setFromRoomOrigin`.

The 3D view uses the same screen coordinates in inches: three.js `x` = east, `z` = south, `y` = up. Each piece is a group at its center with `rotation.y = −rot` (radians), and local front = −z.
