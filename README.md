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

Deep links: `http://127.0.0.1:8642/?map=Levels/ACT%201/M1M2/01%20Main.zax&view=2010,1884,1&select=fruit%20relay`
opens a map centred on x, y at a zoom (1 = 100%) and selects an object by name;
add `&props=1` to open its properties window, `&on=collision,grid` to switch
view toggles on for that page load.

## Using it

| Action | How |
|---|---|
| Open a map | File > Open map..., Ctrl+O (double-click a map) |
| Pan | Hand tool (H), or drag with the middle/right mouse button; arrow keys; scrollbars; click/drag the minimap |
| Zoom | Mouse wheel (around the cursor), + / -, F to fit, 1 for 100% |
| Inspect an object | Select tool (S): click a marker, or click it in the Objects list (centres the view) |
| Layers | Objects tab: tick categories on/off; filter by name or model |
| Toggles | G tile grid, L object names, I invisible objects, T terrain, P object sprites, M markers on top of sprites, E events, C collision mask |
| Events | Events tab lists every object with triggers/relays/actions; select one to see its outline and "referenced by" in Properties (names are links) and arrows on the map |
| Properties window | Double-click an object (map, Objects or Events list): tabs General (grouped: identity with sprite preview, placement, state flags, gameplay, other), Events, Links, All properties (tree), Source. Several can be open; drag by the title, resize from the corner |
| Palette | All 1118 models of the game, like the Heroes 3 object palette: category buttons, area selector, search, thumbnails grouped by folder; the yellow badge counts uses on the open map. Click a model to highlight its instances on the map, step through them with the arrows (or double-click the tile) |
| Item uses | Select a pickup (or any object): Properties and the Links tab list "Uses of item": events in any map that check for, give, use or discover the inventory item it gives (weapon parts: that segment only), or that create its model. Links select the object, or open its map |
| Other maps, dialogue | In event outlines, purple links open another map with the target object selected; speech-bubble links show the dialogue line and play its voice. "Entered from other maps" (Properties, Map tab) lists events elsewhere leading here |

The Properties tab shows the object's original text from the level file; the
Map tab shows the level's settings and its terrain textures. The status bar
shows the cursor position and which terrain textures blend there.

Objects are drawn with the first frame of their current sequence (`Cur
Sequence`, usually Idle), back to front by Y. Objects without a sprite, and
all objects when sprites are off, get markers: squares are scenery
(`Environments/...` models), circles everything else; dashed outlines are
objects with `Visible=0` (mostly editor markers: triggers, paths, spawn
points). Clicking picks the sprite pixel under the cursor.

### Events

With Events on (E), trigger areas are drawn on the map: polygons
(`CFreeRangePoly` with a polygon trigger) and ellipses (oval triggers), yellow
when players set them off, red for enemies/anything, orange for both, dashed
if they fire only once, faint if the object starts inactive. Event sources get
an icon (lightning: trigger, circle arrow: relay listener, star: spawn point,
gear: other). Selecting an object draws arrows to everything its events refer
to (green activate/open, red deactivate/delete/close, orange relay, blue other)
and dashed arrows from events elsewhere that refer to it. Event sources stay
visible while Events is on even if they are invisible in the game (relays are
hidden editor objects). Plain polygons (collision blockers etc.) are in the
Polygons layer, off by default.

## How it works

- `zaxed/archive.py` - DATA.dat is a ZIP (entries stored) whose end-of-central-
  directory signature is `RE\x05\x06` instead of `PK\x05\x06`; it is read
  through a wrapper that presents the standard signature.
- `zaxed/zaxfile.py` - parser for the engine's text format (`.zax` levels and
  other `ClassName { Key=Value ... }` files); nodes keep their line ranges.
- `zaxed/server.py` - local HTTP API (level list, level summary, object text,
  terrain textures, object sprites as PNG) and the static web UI.
- `zaxed/model.py` - model (.mdl16) frame finder, RLE decoder, PNG encoder.
- `zaxed/events.py` - readable event trees from objects' Activity (triggers,
  relays, nested actions); references found by matching values to object names;
  map targets (`New Map Name` / `New Location`, `Other Map Name`) and dialogue.
- `zaxed/scripts.py` - dialogue lookup in `.RDS` scripts (+ voice file) and the
  cross-map index (built in the background at startup, ~10 s for all maps).
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

**Events**: each object has an `Activity` array of AI components. Triggers:
`CTouchingPolygonTriggerAI` (on a `CFreeRangePoly` level part, whose
`Polygon=x, y, x, y, ...` is the area), `CTouchingOvalTriggerAI` (`X Radius`,
`YX Ratio` around the object), `CPassThroughTriggerAI`, `CollideTriggerAI`;
fields `Triggered By Players/Enemies/Projectiles/Anything/Name`, `Trigger Only
Once`, `Enter/Exit/Repeat Action`. `CRelayAI` runs its `Action` when a
`CTriggerRelayAction` fires `Relay Name` = the relay object's name. Actions
nest (`CMultipleActionsAction`, `CSeriesAction`, `CConditionalAction` with
`Try/Succeed/Fail Action`, `CDelayAction`...) and refer to objects by name
(`Target Name`, `Relay Name`, `New Location`...); `CZaxDialogAction` refers to
a mission script (`.RDS`) line (voice: `VOs/<line>.ogg` next to the script).
Objects can also carry actions of their own: `Destroyed Action` (750 in the
game), `Damaged Action`, `Collided While Rotating Action`; ZaxEd lists them as
"When destroyed" etc. (skull icon). Spawn pads are `CGeneratorAI` (Things to
Generate: weighted models, Max Simultaneous, Delay Between Spawns, After
Action for each spawn); a pad's power source has `Destroyed Action =
CSendMessageAction(Message=turn gen off, Target=<pad name>)`, which stops the
generator ("turn gen on" restarts one).
Object names in events are matched ignoring case, as the game does (the
pedestal next to the "Mega 6" pickup runs `CDeleteAction(Target Name=mega 6)`).
**Items**: a pickup model's `CPickupAI` names the inventory item it gives (an
`Inventory/Item Definitions/<def>.txt`; weapon parts add a segment such as
`MegaFusionDisruptor/fusionbarrell1part`). Events refer to items by
definition: `Inventory Item Definition` in CCheckForInventoryItemAction,
CGiveDefaultInventoryItemAction, CUseInventoryItemAction,
CDiscoverInventoryItemAction and CUseChargeFromInventoryItemAction, or a
nested item node (`Definition Index`, `Segments`) in
CGiveCustomInventoryItemAction. Models are created by
CCreateDefaultEntityAction (`Model to Create`), CSetModelAction and spawners.
`CSwitchMapAction`, `CTeleportAction` and `CRelocateAction` go to `New Map
Name` (= `Levels/<name>.zax`, any case) at the object named `New Location`
there; `COtherMapAction` (`Other Map Name`) runs its nested actions in that
other map, so names inside it refer to objects there.

**Collision**: every model has one outline: `POLY2D\0`, a type byte (7), a
u32 point count, then x, y floats relative to the object's position (closed,
last point = first; count 0 = no collision). Objects with `Collideable=1`
block with that outline; `Full Height=1` blocks everything, `Half Height=1`
are low obstacles. `CFreeRangePoly` parts with `Collideable=1` and no trigger
are invisible blockers. Models whose object has a `CPickupAI` (items, some
collectable scenery) are pickups: touching collects them. `Stationary` is set
on everything, so characters are recognised by category / entity class. The
Collision mask view (C) draws: red immovable full height, orange immovable
half height, blue characters, green dotted pickups; faint and dashed if the
object starts inactive.

**Object sprites**: `Cache/Models/<Model>.mdl16`, a binary serialisation of
the model object (length-prefixed strings, floats, nested objects). Its
renderable part is a list of sequences, each a name (`Idle`, `Idle 2`,
`Closed`, `Idle Shadow`...), a blend mode (`Transparent Mask`; `Blend Black
Bias` = additive glow overlay) and its frames back to back (characters:
directions x animation frames). Frame header as in `.frm16` (tag `0x1031`,
hotspot x/y = position of the object's origin inside the image, so draw at
X - hx, Y - hy; width, height; image size at +36 counting itself), then RLE
rows: `1nnnnnnn` skip n, `01nnnnnn` n literal RGB565 pixels, `00nnnnnn` next
pixel repeated n times; then a row offset table, a mask and a second image.
ZaxEd finds frames by scanning for the tag and accepting only exact RLE
decodes, and labels each group of frames by the two strings before it
(`zaxed/model.py`). Shadow sequences have an empty colour image; their shadow
is in the mask/second image (not decoded yet).

## Roadmap

1. Viewer: terrain + object markers (done).
2. Object sprites from `.mdl16`, back-to-front order (done). Next: shadows,
   glow overlays, choosing direction/sequence per object.
3. Events: trigger areas, relays, action outlines, links (done, read-only).
4. Editing: move/delete/duplicate objects, edit properties and events, save as a copy.
5. Terrain painting (elevation brush), new maps.
