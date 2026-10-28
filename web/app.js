'use strict';
// ZaxEd web UI: map view, minimap, object list and properties.

const TILE = 64;            // terrain grid spacing and render tile size (world px)
const OV_SCALE = 4;         // overview image: 1 pixel per 4x4 world px
const ZOOM_MAX = 4;
const CATEGORY_COLORS = {
  'Environments': '#c08a4a',
  'Characters': '#ff4040',
  'Items': '#ffd400',
  'Editor': '#40d8ff',
  'Special Effects': '#c070ff',
  'Polygons': '#7dff9a',
  'Trigger areas': '#ffd400',
  '(none)': '#ffffff',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  path: null,
  level: null,
  textures: [],            // per terrain texture: {w, h, rgba} or null if missing
  view: { x: 0, y: 0, zoom: 1 },
  tool: 'select',
  toggles: { grid: false, labels: false, hidden: false, terrain: true, sprites: true, markers: false, events: true, collision: false },
  byName: new Map(),       // object name (lower case: the game ignores case) -> [ids]
  incoming: new Map(),     // object name (lower case) -> [{id, label, cls}] events elsewhere referring to it
  itemrefs: new Map(),     // /api/itemrefs query -> promise of events using an item / model
  sprites: new Map(),      // "model|seq" -> {img, hx, hy, w, h, alpha} | null (none) | 'loading'
  drawOrder: [],           // object ids sorted by y (back to front)
  layers: {},              // category -> visible
  filter: '',
  selected: -1,
  tiles: new Map(),        // "tx,ty" -> canvas
  queue: [],               // tiles waiting to be rendered
  overview: null,          // canvas, W/OV_SCALE x H/OV_SCALE
};

const store = {
  get(key, fallback) { try { const v = localStorage.getItem('zaxed.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('zaxed.' + key, JSON.stringify(value)); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- data

async function api(path, type = 'json') {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return type === 'json' ? res.json() : type === 'text' ? res.text() : res.arrayBuffer();
}

async function loadTexture(name) {
  try {
    const buf = await api('/api/texture?name=' + encodeURIComponent(name), 'bin');
    const dv = new DataView(buf);
    const w = dv.getUint16(0, true), h = dv.getUint16(2, true);
    const px = new Uint16Array(buf, 4, w * h);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const c = px[i];
      const r = c >> 11, g = (c >> 5) & 63, b = c & 31;
      rgba[i * 4] = (r << 3) | (r >> 2);
      rgba[i * 4 + 1] = (g << 2) | (g >> 4);
      rgba[i * 4 + 2] = (b << 3) | (b >> 2);
      rgba[i * 4 + 3] = 255;
    }
    return { w, h, rgba };
  } catch (e) {
    console.warn('texture', name, e);
    return null;
  }
}

// opts: {select: object name, selectId: object id} to select after loading
async function openLevel(path, opts = {}) {
  showLoading(true);
  try {
    const level = await api('/api/level?path=' + encodeURIComponent(path));
    const terrain = level.terrain;
    const textures = terrain ? await Promise.all(terrain.textures.map(loadTexture)) : [];
    state.path = path;
    state.level = level;
    state.textures = textures;
    state.tiles.clear();
    state.queue = [];
    state.selected = -1;
    state.crossrefs = null;          // null until /api/crossrefs answers
    for (const w of $$('.float')) if (!w.dataset.key || !w.dataset.key.startsWith('dlg|')) w.remove();
    const cats = [...new Set(level.objects.map((o) => o.category))].sort();
    const saved = store.get('layers', {});
    // plain polygons (blockers...) are big and many: off unless asked for
    state.layers = Object.fromEntries(cats.map((c) => [c, saved[c] !== undefined ? saved[c] : c !== 'Polygons']));
    state.overview = renderOverview();
    indexEvents(level);
    state.drawOrder = level.objects.map((o) => o.id).sort((a, b) => level.objects[a].y - level.objects[b].y || a - b);
    loadSprites();
    store.set('last', path);
    $('#empty').style.display = 'none';
    document.title = `ZaxEd - ${level.info['Map Description'] || path}`;
    buildLayers();
    buildObjectList();
    buildMapInfo();
    if (palette.models) { refreshPaletteInstances(); buildPaletteGrid(); }
    showProperties();
    fit();
    const v = new URLSearchParams(location.search).get('view');     // view=x,y,zoom
    if (v && path === new URLSearchParams(location.search).get('map')) {
      const [x, y, zoom] = v.split(',').map(Number);
      state.view.zoom = zoom || 1;
      centerOn(x, y);
    }
    let pick = new URLSearchParams(location.search).get('select');     // select=<object name>
    if (path !== new URLSearchParams(location.search).get('map')) pick = null;
    pick = opts.select || pick;
    const pickId = opts.selectId !== undefined ? opts.selectId : (pick && state.byName.has(pick.toLowerCase()) ? state.byName.get(pick.toLowerCase())[0] : -1);
    if (pickId >= 0) {
      select(pickId, !v || opts.select !== undefined || opts.selectId !== undefined);
      for (const t of $$('.tab')) if (t.dataset.tab === 'props') t.click();
      if (new URLSearchParams(location.search).get('props') && !opts.select && opts.selectId === undefined) openObjectWindow(pickId);
    }
    // events in other maps leading here (index may still be building)
    api('/api/crossrefs?path=' + encodeURIComponent(path)).then((refs) => {
      if (state.path !== path) return;
      state.crossrefs = refs;
      buildMapInfo();
      showProperties();
    }).catch(() => {});
  } catch (e) {
    alert('Could not open map:\n' + e.message);
  } finally {
    showLoading(false);
  }
}

// ---------------------------------------------------------------- sprites

const spriteKey = (o) => o.model + '|' + (o.seq || '');

async function loadSprite(o) {
  const key = spriteKey(o);
  state.sprites.set(key, 'loading');
  try {
    const res = await fetch(`/api/sprite?model=${encodeURIComponent(o.model)}&seq=${encodeURIComponent(o.seq || '')}`);
    if (!res.ok) { state.sprites.set(key, null); return; }
    const [hx, hy] = (res.headers.get('X-Hotspot') || '0,0').split(',').map(Number);
    const img = await createImageBitmap(await res.blob());
    // alpha mask for pixel-accurate clicks
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const alpha = new Uint8Array(img.width * img.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3];
    state.sprites.set(key, { img, hx, hy, w: img.width, h: img.height, alpha, seq: res.headers.get('X-Sequence') });
  } catch (e) {
    console.warn('sprite', key, e);
    state.sprites.set(key, null);
  }
  redraw();
}

// Fetch every model's sprite in the background, a few at a time.
async function loadSprites() {
  const level = state.level;
  const todo = [];
  const seen = new Set();
  for (const o of level.objects) {
    const key = spriteKey(o);
    if (o.model && !seen.has(key) && !state.sprites.has(key)) { seen.add(key); todo.push(o); }
  }
  const worker = async () => {
    while (todo.length && state.level === level) await loadSprite(todo.shift());
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

function spriteOf(o) {
  const s = o.model ? state.sprites.get(spriteKey(o)) : null;
  return s && s !== 'loading' ? s : null;
}

// Objects drawn as sprites: shown in game (Visible=1), layer on, sprite known.
function drawsSprite(o) {
  return state.toggles.sprites && o.visible && state.layers[o.category] !== false && !!spriteOf(o);
}

// ---------------------------------------------------------------- events

const EVENT_ICONS = {
  CTouchingPolygonTriggerAI: '⚡', CTouchingOvalTriggerAI: '⚡', CPassThroughTriggerAI: '⚡',
  CollideTriggerAI: '⚡', CRelayAI: '↻', CSpawnPointAI: '✱', CGeneratorAI: '⭗',
  'Destroyed Action': '☠', 'Damaged Action': '☠',
};

function walkEvent(e, fn, depth = 0) {
  fn(e, depth);
  for (const c of e.children) walkEvent(c, fn, depth + 1);
}

function indexEvents(level) {
  state.byName = new Map();
  state.incoming = new Map();
  for (const o of level.objects) {
    if (!o.name) continue;
    const key = o.name.toLowerCase();
    if (!state.byName.has(key)) state.byName.set(key, []);
    state.byName.get(key).push(o.id);
  }
  for (const o of level.objects)
    for (const e of o.events)
      walkEvent(e, (n) => {
        for (const ref of n.refs) {
          const key = ref.toLowerCase();
          if (!state.incoming.has(key)) state.incoming.set(key, []);
          state.incoming.get(key).push({ id: o.id, label: n.label, cls: n.cls });
        }
      });
}

function triggerOf(o) {
  return o.events.find((e) => e.trigger);
}

function triggerColor(t) {
  if (t.players && t.enemies) return [255, 150, 40];
  if (t.players) return [255, 212, 0];
  if (t.enemies) return [255, 70, 70];
  return [170, 170, 170];
}

// Area of an object on the map: its polygon, or its oval trigger's ellipse.
function shapeOf(o) {
  if (o.polygon) {
    const pts = o.polygon;
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return {
      pts, area: Math.abs(area / 2),
      contains(x, y) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      },
    };
  }
  const t = triggerOf(o);
  if (state.toggles.events && t && t.trigger.radius) {
    const rx = t.trigger.radius, ry = rx * (t.trigger.ratio || 1);
    return { rx, ry, area: Math.PI * rx * ry, contains: (x, y) => ((x - o.x) / rx) ** 2 + ((y - o.y) / ry) ** 2 <= 1 };
  }
  return null;
}

function drawEvents(ctx, sx, sy, z) {
  const L = state.level;
  for (const o of L.objects) {
    if (state.layers[o.category] === false) continue;
    const t = triggerOf(o);
    const shape = (o.polygon || (state.toggles.events && t)) ? shapeOf(o) : null;
    if (!shape) continue;
    const showTrigger = state.toggles.events && t;
    if (!showTrigger && !o.visible && !state.toggles.hidden) continue;
    ctx.beginPath();
    if (shape.pts) {
      shape.pts.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      ctx.closePath();
    } else ctx.ellipse(sx(o.x), sy(o.y), shape.rx * z, shape.ry * z, 0, 0, Math.PI * 2);
    if (showTrigger) {
      const [r, g, b] = triggerColor(t.trigger);
      ctx.fillStyle = `rgba(${r},${g},${b},${o.active ? 0.18 : 0.08})`;
      ctx.fill();
      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.lineWidth = o.id === state.selected ? 2.5 : 1.5;
      ctx.setLineDash(t.trigger.once ? [6, 4] : []);
    } else {
      ctx.strokeStyle = 'rgba(125,255,154,0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!state.toggles.events) return;
  // event icons next to event sources
  ctx.font = 'bold 12px Tahoma, sans-serif';
  for (const o of L.objects) {
    if (!o.events.length || !objectVisible(o)) continue;
    const icon = EVENT_ICONS[o.events[0].cls] || '⚙';
    const x = sx(o.x) + 6, y = sy(o.y) - 6;
    ctx.fillStyle = '#000'; ctx.fillText(icon, x + 1, y + 1);
    ctx.fillStyle = '#ff80ff'; ctx.fillText(icon, x, y);
  }
}

function linkColor(cls, label) {
  if (cls === 'CSendMessageAction') return / on'/i.test(label || '') ? '#40ff60' : / off'/i.test(label || '') ? '#ff5050' : '#ff70d0';
  if (cls === 'CActivateAction' || cls === 'COpenDoorAction') return '#40ff60';
  if (cls === 'CDeactivateAction' || cls === 'CDeleteAction' || cls === 'CDestroyAction' || cls === 'CCloseDoorAction') return '#ff5050';
  if (cls === 'CTriggerRelayAction') return '#ffa030';
  return '#40d8ff';
}

function arrow(ctx, x1, y1, x2, y2, color, dashed) {
  const a = Math.atan2(y2 - y1, x2 - x1), d = Math.hypot(x2 - x1, y2 - y1);
  if (d < 4) return;
  const ex = x2 - Math.cos(a) * 8, ey = y2 - Math.sin(a) * 8;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
  ctx.setLineDash(dashed ? [5, 4] : []);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x2 - Math.cos(a) * 3, y2 - Math.sin(a) * 3);
  ctx.lineTo(ex - Math.cos(a - 0.5) * 8, ey - Math.sin(a - 0.5) * 8);
  ctx.lineTo(ex - Math.cos(a + 0.5) * 8, ey - Math.sin(a + 0.5) * 8);
  ctx.closePath(); ctx.fill();
}

// Arrows from the selected object to what its events refer to (solid) and
// from events elsewhere that refer to it (dashed).
function drawLinks(ctx, sel, sx, sy) {
  const L = state.level;
  for (const e of sel.events)
    walkEvent(e, (n) => {
      for (const ref of n.refs)
        for (const id of state.byName.get(ref.toLowerCase()) || [])
          if (id !== sel.id) arrow(ctx, sx(sel.x), sy(sel.y), sx(L.objects[id].x), sy(L.objects[id].y), linkColor(n.cls, n.label), false);
    });
  for (const inc of (sel.name && state.incoming.get(sel.name.toLowerCase())) || [])
    if (inc.id !== sel.id) arrow(ctx, sx(L.objects[inc.id].x), sy(L.objects[inc.id].y), sx(sel.x), sy(sel.y), linkColor(inc.cls, inc.label), true);
}

function objectTitle(o) {
  if (o.name) return o.name;
  if (o.polygon) return `${o.category === 'Trigger areas' ? 'Trigger area' : 'Polygon'} #${o.id}`;
  return o.model ? o.model.split('/').pop() : o.cls;
}

function buildEventList() {
  const list = $('#evlist');
  if (!list) return;
  list.innerHTML = '';
  if (!state.level) return;
  const f = ($('#evfilter').value || '').toLowerCase();
  const frag = document.createDocumentFragment();
  for (const o of state.level.objects) {
    if (!o.events.length || state.layers[o.category] === false) continue;
    const summary = o.events.map((e) => e.label).join('; ');
    if (f && !(objectTitle(o).toLowerCase().includes(f) || summary.toLowerCase().includes(f))) continue;
    const row = document.createElement('div');
    row.className = 'row' + (o.id === state.selected ? ' sel' : '');
    row.dataset.id = o.id;
    row.title = summary;
    const icon = document.createElement('span');
    icon.className = 'evicon';
    icon.textContent = EVENT_ICONS[o.events[0].cls] || '⚙';
    const text = document.createElement('span');
    text.textContent = objectTitle(o);
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = summary;
    row.append(icon, text, dim);
    frag.append(row);
  }
  list.append(frag);
}

function refLink(name) {
  const a = document.createElement('a');
  a.textContent = name;
  a.href = '#';
  const ids = state.byName.get(name.toLowerCase()) || [];
  if (!ids.length) a.classList.add('dead');
  a.addEventListener('click', (ev) => { ev.preventDefault(); if (ids.length) select(ids[0], true); });
  return a;
}

function showEvents(o) {
  const box = $('#propsevents');
  box.innerHTML = '';
  if (o.events.length) {
    box.append(el('div', 'caption', 'Events'));
    renderEvents(box, o);
  }
  renderIncoming(box, o);
}

// ---------------------------------------------------------------- collision

// Collision outline of an object in world coordinates, or null: blocker
// polygons (not trigger areas), and model outlines (POLY2D) of collideable
// objects, placed at their position.
function collisionOf(o) {
  if (!o.collideable) return null;
  if (o.polygon) return o.category === 'Polygons' ? o.polygon : null;
  if (!o.collision) return null;
  return o.collision.map(([x, y]) => [o.x + x, o.y + y]);
}

const MOBILE_CLASSES = new Set(['CEntityWalking', 'CEntityFlying', 'CEntityAnimatedUpperBody']);

// What kind of collision an object has: 'pickup' (collected on touch),
// 'mobile' (characters: block, but move), 'half' (low obstacle), 'full'.
function collisionKind(o) {
  if (o.pickup) return 'pickup';
  if (o.category === 'Characters' || MOBILE_CLASSES.has(o.cls)) return 'mobile';
  return o.half_height && !o.full_height ? 'half' : 'full';
}

const COLLISION_STYLE = {
  full: { rgb: [255, 40, 40], fill: 0.35, dash: [] },
  half: { rgb: [255, 150, 30], fill: 0.35, dash: [] },
  mobile: { rgb: [70, 150, 255], fill: 0.25, dash: [] },
  pickup: { rgb: [60, 230, 90], fill: 0.2, dash: [2, 3] },
};

// Collision mask layer: red = immovable, full height (blocks everything);
// orange = immovable, half height (low obstacles); blue = characters;
// green dotted = pickups. Faint and dashed = inactive (events can switch it on).
function drawCollision(ctx, sx, sy) {
  for (const o of state.level.objects) {
    if (state.layers[o.category] === false && o.category !== 'Polygons') continue;
    const pts = collisionOf(o);
    if (!pts || pts.length < 3) continue;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.closePath();
    const st = COLLISION_STYLE[collisionKind(o)];
    const [r, g, b] = st.rgb;
    ctx.fillStyle = `rgba(${r},${g},${b},${o.active ? st.fill : 0.1})`;
    ctx.fill();
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = st.dash.length ? 2 : 1;
    ctx.setLineDash(o.active ? st.dash : [4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---------------------------------------------------------------- terrain

// Elevation (0..255) at a world position: bilinear between the grid corners.
function elevation(x, y) {
  const t = state.level.terrain;
  const gx = x / TILE, gy = y / TILE;
  const c0 = Math.min(Math.max(Math.floor(gx), 0), t.cols - 1), r0 = Math.min(Math.max(Math.floor(gy), 0), t.rows - 1);
  const c1 = Math.min(c0 + 1, t.cols - 1), r1 = Math.min(r0 + 1, t.rows - 1);
  const fx = Math.min(Math.max(gx - c0, 0), 1), fy = Math.min(Math.max(gy - r0, 0), 1);
  const top = t.grid[r0][c0] * (1 - fx) + t.grid[r0][c1] * fx;
  const bot = t.grid[r1][c0] * (1 - fx) + t.grid[r1][c1] * fx;
  return top * (1 - fy) + bot * fy;
}

// Which textures an elevation blends: N textures span 0..255 in N-1 bands.
function groundAt(e) {
  const n = state.textures.length;
  if (n <= 1) return { a: 0, b: 0, f: 0 };
  const t = (e * (n - 1)) / 255;
  const a = Math.min(Math.floor(t), n - 2);
  return { a, b: a + 1, f: t - a };
}

// Terrain colour at a world position into out[o..o+2].
function terrainPixel(x, y, out, o) {
  const g = groundAt(elevation(x, y));
  const ta = state.textures[g.a], tb = state.textures[g.b];
  if (!ta || !tb) {                       // missing texture: checker
    const v = ((x >> 3) ^ (y >> 3)) & 1 ? 255 : 80;
    out[o] = v; out[o + 1] = 0; out[o + 2] = v; out[o + 3] = 255;
    return;
  }
  const ia = (((y & (ta.h - 1)) * ta.w) + (x & (ta.w - 1))) * 4;
  const ib = (((y & (tb.h - 1)) * tb.w) + (x & (tb.w - 1))) * 4;
  const f = g.f, k = 1 - f;
  out[o] = ta.rgba[ia] * k + tb.rgba[ib] * f;
  out[o + 1] = ta.rgba[ia + 1] * k + tb.rgba[ib + 1] * f;
  out[o + 2] = ta.rgba[ia + 2] * k + tb.rgba[ib + 2] * f;
  out[o + 3] = 255;
}

function renderTile(tx, ty) {
  const cv = document.createElement('canvas');
  cv.width = TILE; cv.height = TILE;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(TILE, TILE);
  const { width: W, height: H } = state.level;
  for (let py = 0; py < TILE; py++) {
    const y = ty * TILE + py;
    for (let px = 0; px < TILE; px++) {
      const x = tx * TILE + px, o = (py * TILE + px) * 4;
      if (x >= W || y >= H) { img.data[o + 3] = 0; continue; }
      terrainPixel(x, y, img.data, o);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function renderOverview() {
  const { width: W, height: H, terrain } = state.level;
  const w = Math.max(1, Math.ceil(W / OV_SCALE)), h = Math.max(1, Math.ceil(H / OV_SCALE));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  if (!terrain) return cv;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      terrainPixel(x * OV_SCALE + 1, y * OV_SCALE + 1, img.data, (y * w + x) * 4);
  ctx.putImageData(img, 0, 0);
  return cv;
}

// ---------------------------------------------------------------- view

const mapCanvas = $('#map');
const mapCtx = mapCanvas.getContext('2d');
let drawPending = false;

function viewSize() {
  return { w: mapCanvas.clientWidth, h: mapCanvas.clientHeight };
}

function clampView() {
  const v = state.view, L = state.level;
  if (!L) return;
  const { w, h } = viewSize();
  const vw = w / v.zoom, vh = h / v.zoom;
  v.x = vw >= L.width ? (L.width - vw) / 2 : Math.min(Math.max(v.x, 0), L.width - vw);
  v.y = vh >= L.height ? (L.height - vh) / 2 : Math.min(Math.max(v.y, 0), L.height - vh);
}

function minZoom() {
  const L = state.level, { w, h } = viewSize();
  return L ? Math.min(w / L.width, h / L.height) * 0.5 : 0.05;
}

function setZoom(z, cx, cy) {
  const v = state.view, { w, h } = viewSize();
  cx = cx === undefined ? w / 2 : cx; cy = cy === undefined ? h / 2 : cy;
  const wx = v.x + cx / v.zoom, wy = v.y + cy / v.zoom;
  v.zoom = Math.min(Math.max(z, minZoom()), ZOOM_MAX);
  v.x = wx - cx / v.zoom; v.y = wy - cy / v.zoom;
  redraw();
}

function fit() {
  const L = state.level, { w, h } = viewSize();
  if (!L) return;
  state.view.zoom = Math.min(w / L.width, h / L.height) * 0.97;
  state.view.x = 0; state.view.y = 0;
  redraw();
}

function centerOn(x, y) {
  const { w, h } = viewSize();
  state.view.x = x - w / 2 / state.view.zoom;
  state.view.y = y - h / 2 / state.view.zoom;
  redraw();
}

function redraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => { drawPending = false; draw(); });
}

function objectVisible(o) {
  return state.layers[o.category] !== false &&
    (o.visible || state.toggles.hidden || (state.toggles.events && o.events.length > 0));
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = viewSize();
  if (mapCanvas.width !== Math.round(w * dpr) || mapCanvas.height !== Math.round(h * dpr)) {
    mapCanvas.width = Math.round(w * dpr); mapCanvas.height = Math.round(h * dpr);
  }
  const ctx = mapCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#101010';
  ctx.fillRect(0, 0, w, h);
  const L = state.level;
  if (!L) return;
  clampView();
  const v = state.view, z = v.zoom;
  const sx = (x) => (x - v.x) * z, sy = (y) => (y - v.y) * z;

  // terrain: overview when zoomed out, rendered tiles when zoomed in
  if (state.toggles.terrain && L.terrain) {
    if (z <= 1 / OV_SCALE * 1.01) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(state.overview, sx(0), sy(0), state.overview.width * OV_SCALE * z, state.overview.height * OV_SCALE * z);
    } else {
      ctx.imageSmoothingEnabled = z < 1;
      const tx0 = Math.max(0, Math.floor(v.x / TILE)), ty0 = Math.max(0, Math.floor(v.y / TILE));
      const tx1 = Math.min(Math.ceil(L.width / TILE), Math.ceil((v.x + w / z) / TILE));
      const ty1 = Math.min(Math.ceil(L.height / TILE), Math.ceil((v.y + h / z) / TILE));
      let missing = 0;
      for (let ty = ty0; ty < ty1; ty++)
        for (let tx = tx0; tx < tx1; tx++) {
          const tile = state.tiles.get(tx + ',' + ty);
          const dx = sx(tx * TILE), dy = sy(ty * TILE), ds = TILE * z;
          if (tile) ctx.drawImage(tile, dx, dy, ds + 0.5, ds + 0.5);
          else {
            missing++;
            // placeholder from the overview until the tile is rendered
            ctx.drawImage(state.overview, tx * TILE / OV_SCALE, ty * TILE / OV_SCALE, TILE / OV_SCALE, TILE / OV_SCALE, dx, dy, ds + 0.5, ds + 0.5);
          }
        }
      if (missing) renderSomeTiles(tx0, ty0, tx1, ty1);
    }
  }

  // map border
  ctx.strokeStyle = '#ffffff55';
  ctx.lineWidth = 1;
  ctx.strokeRect(sx(0) + 0.5, sy(0) + 0.5, L.width * z, L.height * z);

  if (state.toggles.grid && z >= 0.2) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    for (let x = Math.ceil(v.x / TILE) * TILE; x <= Math.min(L.width, v.x + w / z); x += TILE) { ctx.moveTo(Math.round(sx(x)) + 0.5, sy(0)); ctx.lineTo(Math.round(sx(x)) + 0.5, sy(L.height)); }
    for (let y = Math.ceil(v.y / TILE) * TILE; y <= Math.min(L.height, v.y + h / z); y += TILE) { ctx.moveTo(sx(0), Math.round(sy(y)) + 0.5); ctx.lineTo(sx(L.width), Math.round(sy(y)) + 0.5); }
    ctx.stroke();
  }

  // object sprites, back to front
  if (state.toggles.sprites) {
    ctx.imageSmoothingEnabled = z < 1;
    for (const id of state.drawOrder) {
      const o = L.objects[id];
      if (!drawsSprite(o)) continue;
      const s = spriteOf(o);
      const x = sx(o.x - s.hx), y = sy(o.y - s.hy);
      if (x > w || y > h || x + s.w * z < 0 || y + s.h * z < 0) continue;
      ctx.drawImage(s.img, x, y, s.w * z, s.h * z);
    }
  }

  if (state.toggles.collision) drawCollision(ctx, sx, sy);
  drawEvents(ctx, sx, sy, z);

  // markers: always without sprites; with sprites only when asked for, or
  // for objects that have no sprite drawn
  const r = z >= 0.5 ? 5 : z >= 0.2 ? 3.5 : 2.5;
  ctx.font = '11px Tahoma, sans-serif';
  for (const o of L.objects) {
    if (!objectVisible(o) || o.polygon) continue;       // polygons are drawn as outlines
    if (drawsSprite(o) && !state.toggles.markers) {
      if (state.toggles.labels && z >= 0.35) drawLabel(ctx, o, sx(o.x), sy(o.y), 0);
      continue;
    }
    const x = sx(o.x), y = sy(o.y);
    if (x < -40 || y < -40 || x > w + 40 || y > h + 40) continue;
    const color = CATEGORY_COLORS[o.category] || '#ffffff';
    ctx.beginPath();
    if (o.category === 'Environments') ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
    else ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#000';
    if (o.visible) { ctx.fillStyle = color; ctx.fill(); ctx.stroke(); }
    else { ctx.strokeStyle = color; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]); }
    if (state.toggles.labels && z >= 0.35) drawLabel(ctx, o, x, y, r);
  }
  drawPaletteHighlight(ctx, sx, sy, z);
  const sel = L.objects[state.selected];
  if (sel) {
    const x = sx(sel.x), y = sy(sel.y);
    const s = drawsSprite(sel) ? spriteOf(sel) : null;
    if (s) {                      // sprite bounds
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(Math.round(sx(sel.x - s.hx)) + 0.5, Math.round(sy(sel.y - s.hy)) + 0.5, s.w * z, s.h * z);
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.arc(x, y, r + 7, 0, Math.PI * 2); ctx.stroke();
    if (state.toggles.events) drawLinks(ctx, sel, sx, sy);
  }

  updateScrollbars();
  drawMinimap();
  $('#st-zoom').textContent = `${Math.round(z * 100)}%`;
}

// Render tiles for a while, nearest the view centre first, then repaint.
function renderSomeTiles(tx0, ty0, tx1, ty1) {
  const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2;
  const todo = [];
  for (let ty = ty0; ty < ty1; ty++)
    for (let tx = tx0; tx < tx1; tx++)
      if (!state.tiles.has(tx + ',' + ty)) todo.push([tx, ty, (tx - cx) ** 2 + (ty - cy) ** 2]);
  todo.sort((a, b) => a[2] - b[2]);
  const start = performance.now();
  for (const [tx, ty] of todo) {
    state.tiles.set(tx + ',' + ty, renderTile(tx, ty));
    if (performance.now() - start > 30) break;
  }
  redraw();
}

// ---------------------------------------------------------------- scrollbars & minimap

function updateScrollbars() {
  const L = state.level, v = state.view, { w, h } = viewSize();
  const hs = $('#hscroll'), vs = $('#vscroll');
  const hthumb = hs.firstElementChild, vthumb = vs.firstElementChild;
  const fw = Math.min(1, w / v.zoom / L.width), fh = Math.min(1, h / v.zoom / L.height);
  const hw = hs.clientWidth, vh = vs.clientHeight;
  hthumb.style.width = Math.max(16, fw * hw) + 'px';
  hthumb.style.left = (L.width ? Math.max(0, v.x / L.width) * hw : 0) + 'px';
  vthumb.style.height = Math.max(16, fh * vh) + 'px';
  vthumb.style.top = (L.height ? Math.max(0, v.y / L.height) * vh : 0) + 'px';
}

function scrollbarDrag(bar, axis) {
  const thumb = bar.firstElementChild;
  bar.addEventListener('mousedown', (e) => {
    if (!state.level) return;
    e.preventDefault();
    const rect = bar.getBoundingClientRect();
    const size = axis === 'x' ? rect.width : rect.height;
    const total = axis === 'x' ? state.level.width : state.level.height;
    const start = axis === 'x' ? e.clientX : e.clientY;
    const origin = state.view[axis];
    if (e.target !== thumb) {     // click on the track: jump there
      const pos = ((axis === 'x' ? e.clientX - rect.left : e.clientY - rect.top) / size) * total;
      const { w, h } = viewSize();
      state.view[axis] = pos - (axis === 'x' ? w : h) / 2 / state.view.zoom;
      redraw();
      return;
    }
    const move = (ev) => {
      const d = ((axis === 'x' ? ev.clientX : ev.clientY) - start) / size * total;
      state.view[axis] = origin + d;
      redraw();
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

const mini = $('#minimap');
const miniCtx = mini.getContext('2d');

function miniGeometry() {
  const L = state.level;
  const s = Math.min(mini.width / L.width, mini.height / L.height);
  return { s, ox: (mini.width - L.width * s) / 2, oy: (mini.height - L.height * s) / 2 };
}

function drawMinimap() {
  const L = state.level;
  miniCtx.fillStyle = '#101010';
  miniCtx.fillRect(0, 0, mini.width, mini.height);
  if (!L) return;
  const { s, ox, oy } = miniGeometry();
  miniCtx.imageSmoothingEnabled = true;
  if (state.toggles.terrain) miniCtx.drawImage(state.overview, ox, oy, L.width * s, L.height * s);
  for (const o of L.objects) {
    if (!objectVisible(o) || o.category === 'Environments') continue;
    miniCtx.fillStyle = CATEGORY_COLORS[o.category] || '#fff';
    miniCtx.fillRect(Math.round(ox + o.x * s) - 1, Math.round(oy + o.y * s) - 1, 2, 2);
  }
  const v = state.view, { w, h } = viewSize();
  miniCtx.strokeStyle = '#fff';
  miniCtx.lineWidth = 1;
  miniCtx.strokeRect(Math.round(ox + v.x * s) + 0.5, Math.round(oy + v.y * s) + 0.5, w / v.zoom * s, h / v.zoom * s);
}

function minimapNavigate(e) {
  if (!state.level) return;
  const rect = mini.getBoundingClientRect();
  const { s, ox, oy } = miniGeometry();
  const mx = (e.clientX - rect.left) * (mini.width / rect.width), my = (e.clientY - rect.top) * (mini.height / rect.height);
  centerOn((mx - ox) / s, (my - oy) / s);
}

// ---------------------------------------------------------------- side panel

function buildLayers() {
  const counts = {};
  for (const o of state.level.objects) counts[o.category] = (counts[o.category] || 0) + 1;
  const box = $('#layers');
  box.innerHTML = '';
  for (const cat of Object.keys(state.layers)) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.layers[cat];
    cb.addEventListener('change', () => {
      state.layers[cat] = cb.checked;
      store.set('layers', state.layers);
      buildObjectList();
      redraw();
    });
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = CATEGORY_COLORS[cat] || '#fff';
    const text = document.createElement('span');
    text.textContent = cat;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = counts[cat];
    label.append(cb, sw, text, count);
    box.append(label);
  }
}

function buildObjectList() {
  buildEventList();
  const list = $('#objlist');
  list.innerHTML = '';
  if (!state.level) return;
  const f = state.filter.toLowerCase();
  const frag = document.createDocumentFragment();
  for (const o of state.level.objects) {
    if (!objectVisible(o)) continue;
    if (f && !(o.name.toLowerCase().includes(f) || o.model.toLowerCase().includes(f))) continue;
    const row = document.createElement('div');
    row.className = 'row' + (o.id === state.selected ? ' sel' : '');
    row.dataset.id = o.id;
    const sw = document.createElement('span');
    sw.className = 'swatch' + (o.visible ? '' : ' hollow');
    sw.style.background = CATEGORY_COLORS[o.category] || '#fff';
    sw.style.borderColor = o.visible ? '#000' : (CATEGORY_COLORS[o.category] || '#fff');
    const text = document.createElement('span');
    text.textContent = objectTitle(o);
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = o.name ? o.model.split('/').pop() : '';
    row.append(sw, text, dim);
    frag.append(row);
  }
  list.append(frag);
}

async function select(id, center) {
  state.selected = id;
  for (const row of $$('#objlist .row, #evlist .row')) row.classList.toggle('sel', Number(row.dataset.id) === id);
  const o = state.level && state.level.objects[id];
  if (o && center) centerOn(o.x, o.y);
  redraw();
  await showProperties();
  if (o) {
    const row = $(`#objlist .row[data-id="${id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

async function showProperties() {
  const info = $('#propsinfo'), pre = $('#propstext');
  const o = state.level && state.level.objects[state.selected];
  if (!o) { info.textContent = 'No object selected.'; pre.textContent = ''; $('#propsevents').innerHTML = ''; return; }
  info.innerHTML = '';
  const add = (k, v) => {
    const line = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = k;
    line.append(b, document.createTextNode(v));
    info.append(line);
  };
  add('Class', o.cls);
  add('Name', o.name || '(unnamed)');
  add('Model', o.model || '(none)');
  add('Position', `${Math.round(o.x)}, ${Math.round(o.y)}`);
  const sp = spriteOf(o);
  add('Sequence', (o.seq || '(none)') + (sp && sp.seq && sp.seq.toLowerCase() !== (o.seq || '').toLowerCase() ? ` (shown: ${sp.seq})` : ''));
  add('Flags', [o.visible ? 'visible' : 'invisible', o.active ? 'active' : 'inactive', o.stationary ? 'stationary' : 'mobile'].join(', '));
  add('In', `${o.container} (lines ${o.first_line + 1}-${o.last_line + 1})`);
  showEvents(o);
  pre.textContent = 'Loading...';
  try {
    pre.textContent = await api(`/api/object?path=${encodeURIComponent(state.path)}&id=${o.id}`, 'text');
  } catch (e) {
    pre.textContent = e.message;
  }
}

function buildMapInfo() {
  const L = state.level;
  const table = $('#mapinfo');
  table.innerHTML = '';
  const rows = [['File', state.path], ...Object.entries(L.info), ['Objects', String(L.objects.length)]];
  if (L.terrain) rows.push(['Terrain grid', `${L.terrain.cols} x ${L.terrain.rows} (64 px), blending ${L.terrain.blending}`]);
  for (const [k, v] of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = v;
  }
  const list = $('#texlist');
  list.innerHTML = '';
  (L.terrain ? L.terrain.textures : []).forEach((name, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const thumb = document.createElement('canvas');
    thumb.className = 'texthumb';
    const tex = state.textures[i];
    if (tex) {
      thumb.width = tex.w; thumb.height = tex.h;
      thumb.getContext('2d').putImageData(new ImageData(tex.rgba, tex.w, tex.h), 0, 0);
    }
    const text = document.createElement('span');
    text.textContent = `${i}: ${name}${tex ? '' : ' (missing)'}`;
    row.append(thumb, text);
    list.append(row);
  });
  const entry = $('#mapentry');
  entry.innerHTML = '';
  for (const r of state.crossrefs || []) {
    const row = el('div', 'evline');
    const a = el('a', '', r.from.replace(/^Levels\//, '').replace(/\.zax$/i, '') + ' \u25B8 ' + r.title);
    a.href = '#';
    a.addEventListener('click', (ev) => { ev.preventDefault(); openLevel(r.from, { selectId: r.id }); });
    row.append(a, document.createTextNode(': ' + r.label));
    entry.append(row);
  }
  if (!entry.children.length) entry.append(el('div', 'dim', state.crossrefs ? 'None found.' : 'Searching...'));
  $('#st-map').textContent = `${L.info['Map Description'] || ''} - ${state.path} - ${L.width} x ${L.height}, ${L.objects.length} objects`;
}

// ---------------------------------------------------------------- open dialog

async function showOpenDialog() {
  const tree = $('#leveltree');
  tree.innerHTML = 'Loading...';
  $('#dialog-open').classList.remove('hidden');
  let chosen = null;
  const names = await api('/api/levels');
  tree.innerHTML = '';
  let lastFolder = null;
  for (const name of names) {
    const parts = name.split('/');
    const folder = parts.slice(1, -1).join(' / ') || 'Levels';
    if (folder !== lastFolder) {
      const f = document.createElement('div');
      f.className = 'row folder';
      f.textContent = '\u{1F4C1} ' + folder;
      tree.append(f);
      lastFolder = folder;
    }
    const row = document.createElement('div');
    row.className = 'row lvl' + (name === state.path ? ' sel' : '');
    row.textContent = parts[parts.length - 1];
    row.addEventListener('click', () => {
      for (const r of tree.querySelectorAll('.sel')) r.classList.remove('sel');
      row.classList.add('sel');
      chosen = name;
    });
    row.addEventListener('dblclick', () => { closeDialogs(); openLevel(name); });
    tree.append(row);
  }
  const sel = tree.querySelector('.sel');
  if (sel) { chosen = state.path; sel.scrollIntoView({ block: 'center' }); }
  $('#open-ok').onclick = () => { if (chosen) { closeDialogs(); openLevel(chosen); } };
}

function closeDialogs() {
  for (const d of $$('.dialog')) d.classList.add('hidden');
}

function showLoading(on) {
  $('#loading').classList.toggle('hidden', !on);
}

// ---------------------------------------------------------------- commands

const commands = {
  open: showOpenDialog,
  reload: () => state.path && openLevel(state.path),
  zoomin: () => setZoom(state.view.zoom * 1.5),
  zoomout: () => setZoom(state.view.zoom / 1.5),
  fit,
  actual: () => setZoom(1),
  'tool-select': () => setTool('select'),
  'tool-hand': () => setTool('hand'),
  about: () => $('#dialog-about').classList.remove('hidden'),
};

function setTool(tool) {
  state.tool = tool;
  for (const b of $$('.tb.tool')) b.classList.toggle('on', b.dataset.cmd === 'tool-' + tool);
  mapCanvas.classList.toggle('hand', tool === 'hand');
}

function toggle(name) {
  state.toggles[name] = !state.toggles[name];
  store.set('toggles', state.toggles);
  syncToggles();
  if (name === 'hidden' || name === 'events') buildObjectList();
  redraw();
}

function syncToggles() {
  for (const el of $$('[data-toggle]')) el.classList.toggle('on', !!state.toggles[el.dataset.toggle]);
}

// ---------------------------------------------------------------- input

// Object under the cursor: markers first (they're drawn on top), then
// sprites from front to back, testing the sprite's alpha.
function hitTest(cx, cy) {
  const L = state.level, v = state.view;
  let best = -1, bestD = 10 * 10;
  for (const o of L.objects) {
    if (!objectVisible(o) || (drawsSprite(o) && !state.toggles.markers)) continue;
    const dx = (o.x - v.x) * v.zoom - cx, dy = (o.y - v.y) * v.zoom - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = o.id; }
  }
  if (best >= 0) return best;
  const wx = v.x + cx / v.zoom, wy = v.y + cy / v.zoom;
  for (let i = state.drawOrder.length - 1; i >= 0; i--) {
    const o = L.objects[state.drawOrder[i]];
    if (!drawsSprite(o)) continue;
    const s = spriteOf(o);
    const px = Math.floor(wx - (o.x - s.hx)), py = Math.floor(wy - (o.y - s.hy));
    if (px >= 0 && py >= 0 && px < s.w && py < s.h && s.alpha[py * s.w + px]) return o.id;
  }
  // trigger areas and polygons: the smallest one containing the point
  let area = Infinity;
  for (const o of L.objects) {
    if (!objectVisible(o)) continue;
    const shape = shapeOf(o);
    if (!shape || !shape.contains(wx, wy)) continue;
    if (shape.area < area) { area = shape.area; best = o.id; }
  }
  return best;
}

function drawLabel(ctx, o, x, y, r) {
  const label = o.name || o.model.split('/').pop();
  ctx.fillStyle = '#000'; ctx.fillText(label, x + r + 3, y + 4);
  ctx.fillStyle = '#fff'; ctx.fillText(label, x + r + 2, y + 3);
}

function setupInput() {
  let drag = null;
  mapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  mapCanvas.addEventListener('dblclick', (e) => {
    if (!state.level || state.tool !== 'select') return;
    const rect = mapCanvas.getBoundingClientRect();
    const id = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (id >= 0) openObjectWindow(id);
  });
  for (const list of ['#objlist', '#evlist'])
    $(list).addEventListener('dblclick', (e) => {
      const row = e.target.closest('.row');
      if (row) openObjectWindow(Number(row.dataset.id));
    });
  mapCanvas.addEventListener('mousedown', (e) => {
    if (!state.level) return;
    const pan = state.tool === 'hand' || e.button === 1 || e.button === 2;
    if (pan) {
      drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
      mapCanvas.classList.add('dragging');
      e.preventDefault();
    } else if (e.button === 0) {
      const rect = mapCanvas.getBoundingClientRect();
      select(hitTest(e.clientX - rect.left, e.clientY - rect.top), false);
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (drag) {
      state.view.x = drag.vx - (e.clientX - drag.x) / state.view.zoom;
      state.view.y = drag.vy - (e.clientY - drag.y) / state.view.zoom;
      redraw();
    }
  });
  window.addEventListener('mouseup', () => { drag = null; mapCanvas.classList.remove('dragging'); });
  mapCanvas.addEventListener('mousemove', (e) => {
    const L = state.level;
    if (!L) return;
    const rect = mapCanvas.getBoundingClientRect();
    const x = state.view.x + (e.clientX - rect.left) / state.view.zoom;
    const y = state.view.y + (e.clientY - rect.top) / state.view.zoom;
    const inside = x >= 0 && y >= 0 && x < L.width && y < L.height;
    $('#st-pos').textContent = inside ? `x ${Math.floor(x)}  y ${Math.floor(y)}` : '';
    if (inside && L.terrain) {
      const e8 = elevation(x, y), g = groundAt(e8), t = L.terrain.textures;
      $('#st-ground').textContent = t.length > 1
        ? `${Math.round(e8)}: ${t[g.a]} ${Math.round((1 - g.f) * 100)}% / ${t[g.b]} ${Math.round(g.f * 100)}%`
        : `${t[0] || ''}`;
    } else $('#st-ground').textContent = '';
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    mapCanvas.title = hit >= 0 ? (L.objects[hit].name || L.objects[hit].model) : '';
  });
  mapCanvas.addEventListener('wheel', (e) => {
    if (!state.level) return;
    e.preventDefault();
    const rect = mapCanvas.getBoundingClientRect();
    setZoom(state.view.zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  scrollbarDrag($('#hscroll'), 'x');
  scrollbarDrag($('#vscroll'), 'y');

  let miniDrag = false;
  mini.addEventListener('mousedown', (e) => { miniDrag = true; minimapNavigate(e); });
  window.addEventListener('mousemove', (e) => { if (miniDrag) minimapNavigate(e); });
  window.addEventListener('mouseup', () => { miniDrag = false; });

  $('#objlist').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) select(Number(row.dataset.id), true);
  });
  $('#filter').addEventListener('input', (e) => { state.filter = e.target.value; buildObjectList(); });
  $('#evfilter').addEventListener('input', buildEventList);
  $('#evlist').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) select(Number(row.dataset.id), true);
  });

  // menus: click to open, hover to switch while one is open
  for (const m of $$('.menu')) {
    m.addEventListener('mousedown', (e) => {
      if (e.target.closest('.dropdown')) return;
      const open = m.classList.contains('open');
      for (const o of $$('.menu')) o.classList.remove('open');
      if (!open) m.classList.add('open');
      e.stopPropagation();
    });
    m.addEventListener('mouseenter', () => {
      if ($$('.menu.open').length) { for (const o of $$('.menu')) o.classList.remove('open'); m.classList.add('open'); }
    });
  }
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) for (const o of $$('.menu')) o.classList.remove('open'); });
  for (const el of $$('[data-cmd]')) el.addEventListener('click', () => {
    if (el.classList.contains('disabled')) return;
    for (const o of $$('.menu')) o.classList.remove('open');
    commands[el.dataset.cmd]();
  });
  for (const el of $$('[data-toggle]')) el.addEventListener('click', () => {
    for (const o of $$('.menu')) o.classList.remove('open');
    toggle(el.dataset.toggle);
  });
  for (const t of $$('.tab')) t.addEventListener('click', () => {
    for (const x of $$('.tab')) x.classList.toggle('active', x === t);
    for (const p of $$('.page')) p.classList.toggle('active', p.id === 'page-' + t.dataset.tab);
  });
  for (const el of $$('[data-close]')) el.addEventListener('click', closeDialogs);

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'o') { e.preventDefault(); showOpenDialog(); return; }
    if (k === 'Escape') { closeDialogs(); select(-1); return; }
    if (k === 'F5') { e.preventDefault(); commands.reload(); return; }
    if (!state.level || e.ctrlKey || e.altKey || e.metaKey) return;
    const step = 200 / state.view.zoom;
    const actions = {
      ArrowLeft: () => { state.view.x -= step; redraw(); }, ArrowRight: () => { state.view.x += step; redraw(); },
      ArrowUp: () => { state.view.y -= step; redraw(); }, ArrowDown: () => { state.view.y += step; redraw(); },
      '+': commands.zoomin, '=': commands.zoomin, '-': commands.zoomout, f: fit, '1': commands.actual,
      g: () => toggle('grid'), l: () => toggle('labels'), i: () => toggle('hidden'), t: () => toggle('terrain'),
      p: () => toggle('sprites'), m: () => toggle('markers'), e: () => toggle('events'),
      c: () => toggle('collision'),
      s: () => setTool('select'), h: () => setTool('hand'),
    };
    const a = actions[k] || actions[k.toLowerCase()];
    if (a) { e.preventDefault(); a(); }
  });
  window.addEventListener('resize', redraw);
}

// ---------------------------------------------------------------- start

state.toggles = Object.assign(state.toggles, store.get('toggles', {}));
for (const t of (new URLSearchParams(location.search).get('on') || '').split(',')) // on=collision,grid
  if (t in state.toggles) state.toggles[t] = true;
setupInput();
syncToggles();
initPalette().catch((e) => console.warn('palette', e));
setTool('select');
redraw();
const params = new URLSearchParams(location.search);
if (params.has('wait')) {      // testing aid: hold the load event (headless screenshots)
  const img = new Image();
  img.src = '/api/wait?ms=' + encodeURIComponent(params.get('wait'));
  img.style.display = 'none';
  document.body.append(img);
}
const start = params.get('map') || store.get('last', null);
if (start) openLevel(start); else showOpenDialog();
