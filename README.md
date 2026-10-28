# ZaxEd

Map viewer (and future editor) for *Zax: The Alien Hunter* (Reflexive, 2001).
It reads the game's `DATA.dat` directly and never changes it.

## Running

```sh
python3 zaxed.py                    # finds DATA.dat in the Steam/Proton install, opens the browser
python3 zaxed.py --data /path/to/Zax/Game/DATA.dat --port 8642 --no-browser
```

Needs only Python 3 (standard library) and a web browser. The server listens on
127.0.0.1 only. Stop it with Ctrl+C.

Deep links: `http://127.0.0.1:8642/?map=Levels/ACT%201/M1M2/01%20Main.zax&view=2010,1884,1`
opens a map centred on x, y at a zoom (1 = 100%).

## Using it

| Action | How |
|---|---|
| Open a map | File > Open map..., Ctrl+O (double-click a map) |
| Pan | Hand tool (H), or drag with the middle/right mouse button; arrow keys; scrollbars; click/drag the minimap |
| Zoom | Mouse wheel (around the cursor), + / -, F to fit, 1 for 100% |
| Inspect an object | Select tool (S): click a marker, or click it in the Objects list (centres the view) |
| Layers | Objects tab: tick categories on/off; filter by name or model |
| Toggles | G tile grid, L object names, I invisible objects, T terrain |

The Properties tab shows the object's original text from the level file; the
Map tab shows the level's settings and its terrain textures. The status bar
shows the cursor position and which terrain textures blend there.

Markers: squares are scenery (`Environments/...` models), circles everything
else; dashed outlines are objects with `Visible=0` (mostly editor markers:
triggers, paths, spawn points).

## How it works

- `zaxed/archive.py` - DATA.dat is a ZIP (entries stored) whose end-of-central-
  directory signature is `RE\x05\x06` instead of `PK\x05\x06`; it is read
  through a wrapper that presents the standard signature.
- `zaxed/zaxfile.py` - parser for the engine's text format (`.zax` levels and
  other `ClassName { Key=Value ... }` files); nodes keep their line ranges.
- `zaxed/server.py` - local HTTP API (level list, level summary, object text,
  terrain textures) and the static web UI.
- `web/` - the UI (plain HTML/CSS/JS, no build step).

## File formats (as far as known)

**Levels** live in `Levels/ACT n/<mission>/` inside DATA.dat: `NN Name.zax`
(the level), `NN Name.way` (binary, probably path-finding data), the mission's
dialogue script `*.RDS` (text: `:label` then `Speaker: line`) and `VOs/*.ogg`.

**`.zax`** is text: root `CLayerSaveData` with `Width`, `Height`, `Map
Description`, environment, mini-map and fog settings, `Plasma Ground`
(terrain), and `Tree List` holding the objects (`Level Part=CEntityBase` etc.,
each with `Model`, `Position X/Y`, `Visible`, AI, actions...).

**Terrain** (`Plasma Ground=CPlasmaTileMap`): `Num Textures`, `Texture N=<name>`
(low to high), and `Elevations Row R=<hex bytes>`: one value 0..255 per 64-px
grid corner (a 4097 x 4097 map has 65 x 65). Values blend through the textures
in order: with N textures, 0..255 spans N-1 bands. ZaxEd interpolates the
values bilinearly across each 64-px tile; the game also applies a noise
("plasma", `Blending`) to the transitions, which ZaxEd doesn't reproduce yet.

**Terrain textures**: `Cache/Textures/<name>.frm16` - 36-byte header (width at
offset 6, height at 8), 128 x 128 RGB565 pixels, 512 trailing bytes. The
`Textures/<name>.TXT` files only hold surface metadata.

**Object sprites**: `Cache/Models/<Model>.mdl16` (sprite sets with named
sequences such as Idle) - not decoded yet.

## Roadmap

1. Viewer: terrain + object markers (done).
2. Object sprites from `.mdl16` (Environments first), proper draw order.
3. Editing: move/delete/duplicate objects, edit properties, save as a copy.
4. Terrain painting (elevation brush), new maps.
