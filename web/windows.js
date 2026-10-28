'use strict';
// ZaxEd floating windows: object properties (double-click), dialogue lines,
// and links to other maps / dialogue. Uses globals from app.js at call time.

let topZ = 100;
let cascade = 0;

// A draggable, non-modal window; returns {el, body, close}.
function createWindow(title, { width = 520, height = 560, key } = {}) {
  if (key) {                                    // one window per key: raise it
    const existing = document.querySelector(`.float[data-key="${CSS.escape(key)}"]`);
    if (existing) { existing.style.zIndex = ++topZ; return null; }
  }
  const el = document.createElement('div');
  el.className = 'window float';
  if (key) el.dataset.key = key;
  el.style.width = width + 'px';
  el.style.height = height + 'px';
  const off = (cascade++ % 8) * 24;
  el.style.left = Math.max(10, Math.min(window.innerWidth - width - 10, 180 + off)) + 'px';
  el.style.top = Math.max(10, Math.min(window.innerHeight - height - 10, 90 + off)) + 'px';
  el.style.zIndex = ++topZ;
  const bar = document.createElement('div');
  bar.className = 'wtitle';
  const text = document.createElement('span');
  text.textContent = title;
  const x = document.createElement('span');
  x.className = 'wclose';
  x.textContent = '✕';
  bar.append(text, x);
  const body = document.createElement('div');
  body.className = 'wbody';
  el.append(bar, body);
  document.body.append(el);
  const close = () => el.remove();
  x.addEventListener('click', close);
  el.addEventListener('mousedown', () => { el.style.zIndex = ++topZ; });
  bar.addEventListener('mousedown', (e) => {
    if (e.target === x) return;
    e.preventDefault();
    const sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
    const move = (ev) => {
      el.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - sx)) + 'px';
      el.style.top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - sy)) + 'px';
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return { el, body, close };
}

// Tab strip whose pages are built on first view.
function makeTabs(container, tabs) {
  const strip = document.createElement('div');
  strip.className = 'wtabs';
  const body = document.createElement('div');
  body.className = 'wtabbody raised';
  container.append(strip, body);
  const pages = tabs.map((t) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.textContent = t.name;
    const page = document.createElement('div');
    page.className = 'wpage';
    strip.append(tab);
    body.append(page);
    return { t, tab, page, built: false };
  });
  const show = (p) => {
    for (const q of pages) { q.tab.classList.toggle('active', q === p); q.page.classList.toggle('active', q === p); }
    if (!p.built) { p.built = true; p.t.build(p.page); }
  };
  for (const p of pages) p.tab.addEventListener('click', () => show(p));
  show(pages[0]);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- links

let levelNames = null;

async function resolveMap(name) {
  if (!levelNames) levelNames = await api('/api/levels');
  const want = `levels/${name}.zax`.toLowerCase();
  return levelNames.find((n) => n.toLowerCase() === want) || null;
}

async function openMapAt(mapName, objectName) {
  const path = mapName.startsWith('Levels/') ? mapName : await resolveMap(mapName);
  if (!path) { alert(`Map not found: ${mapName}`); return; }
  if (path === state.path) {
    const ids = objectName ? state.byName.get(objectName.toLowerCase()) : null;
    if (ids && ids.length) select(ids[0], true);
    return;
  }
  await openLevel(path, { select: objectName });
}

function mapLink(mapName, objectName) {
  const a = el('a', 'maplink', objectName ? `${mapName} ▸ ${objectName}` : mapName);
  a.href = '#';
  a.title = 'Open this map' + (objectName ? ` and select '${objectName}'` : '');
  a.addEventListener('click', (ev) => { ev.preventDefault(); openMapAt(mapName, objectName); });
  return a;
}

function dialogLink(d) {
  const a = el('a', 'dialoglink', '\u{1F4AC} ' + d.line);
  a.href = '#';
  a.title = `${d.script}: ${d.line}`;
  a.addEventListener('click', (ev) => { ev.preventDefault(); showDialog(d.script, d.line); });
  return a;
}

// ---------------------------------------------------------------- dialogue window

async function showDialog(script, line) {
  const w = createWindow('Dialogue - ' + line, { width: 460, height: 300, key: 'dlg|' + script + '|' + line });
  if (!w) return;
  w.body.classList.add('dialogue');
  w.body.append(el('div', 'dim', script + '.RDS'));
  try {
    const d = await api(`/api/dialog?script=${encodeURIComponent(script)}&line=${encodeURIComponent(line)}`);
    const text = el('div', 'sunken dtext');
    if (!d.found) text.append(el('i', '', `Line "${line}" not found in the script.`));
    for (const e of d.entries) {
      const p = el('p');
      if (e.speaker) p.append(el('b', '', e.speaker + ': '));
      p.append(document.createTextNode(e.text));
      text.append(p);
    }
    w.body.append(text);
    if (d.voice) {
      const audio = el('audio');
      audio.controls = true;
      audio.src = '/api/file?name=' + encodeURIComponent(d.voice);
      w.body.append(audio);
      audio.play().catch(() => {});
    } else w.body.append(el('div', 'dim', 'No voice file.'));
  } catch (e) {
    w.body.append(el('div', '', e.message));
  }
}

// ---------------------------------------------------------------- event outline

// Event outline of an object into a container: nested lines with links to
// objects in this map, other maps and dialogue lines.
function renderEvents(box, o) {
  for (const e of o.events)
    walkEvent(e, (n, depth) => {
      const line = el('div', 'evline');
      line.style.marginLeft = 10 + depth * 14 + 'px';
      if (depth) line.append(el('span', 'evkey', n.key + ': '));
      line.append(document.createTextNode(n.label));
      const add = (node) => { line.append(document.createTextNode(' → ')); line.append(node); };
      for (const ref of n.refs) add(refLink(ref));
      if (n.map) add(mapLink(n.map.name, n.map.location));
      for (const r of n.remote || []) add(mapLink(r.map, r.name));
      if (n.dialog) add(dialogLink(n.dialog));
      box.append(line);
    });
}

// Objects in this map and events in other maps that refer to o, then events
// anywhere in the game that use the item it gives or create its model.
function renderIncoming(box, o) {
  const name = o.name.toLowerCase();
  const local = (name && state.incoming.get(name)) || [];
  const remote = (state.crossrefs || []).filter((r) => r.location && r.location.toLowerCase() === name);
  if (local.length) {
    box.append(el('div', 'caption', 'Referenced by'));
    for (const i of local) {
      const src = state.level.objects[i.id];
      const line = el('div', 'evline');
      const a = el('a', '', objectTitle(src));
      a.href = '#';
      a.addEventListener('click', (ev) => { ev.preventDefault(); select(src.id, true); });
      line.append(a, document.createTextNode(': ' + i.label));
      box.append(line);
    }
  }
  if (remote.length) {
    box.append(el('div', 'caption', 'Entered from other maps'));
    for (const r of remote) {
      const line = el('div', 'evline');
      const a = el('a', 'maplink', r.from.replace(/^Levels\//, '').replace(/\.zax$/i, '') + ' \u25B8 ' + r.title);
      a.href = '#';
      a.title = 'Open that map and select the object';
      a.addEventListener('click', (ev) => { ev.preventDefault(); openLevel(r.from, { selectId: r.id }); });
      line.append(a, document.createTextNode(': ' + r.label));
      box.append(line);
    }
  }
  renderItemUsers(box, o);
}

// Events in any map that check / give / use the inventory item o gives (a
// weapon part: only events for its segment or the whole definition), or that
// create o's model. Searched by the server's game-wide index.
function renderItemUsers(box, o) {
  if (!o.item && !o.model) return;
  const segment = o.item && o.item.segments.length ? o.item.segments[0] : '';
  const query = new URLSearchParams({ def: o.item ? o.item.def : '', segment, model: o.model }).toString();
  if (!state.itemrefs.has(query)) state.itemrefs.set(query, api('/api/itemrefs?' + query));
  const what = o.item ? `'${o.item.def}'` + (segment ? ` (${segment.split('/').pop()})` : '') : `'${o.model.split('/').pop()}'`;
  const section = el('div');
  box.append(section);
  const caption = el('div', 'caption', `Uses of ${o.item ? 'item' : 'model'} ${what}`);
  caption.title = o.item ? 'Events in any map that check for, give, use or create this item' : 'Events in any map that create this model';
  section.append(caption, el('div', 'dim', 'Searching all maps...'));
  if (!o.item) section.hidden = true;
  state.itemrefs.get(query).then((refs) => {
    section.lastChild.remove();
    section.hidden = false;
    if (!refs.length) {
      if (o.item) section.append(el('div', 'dim', 'No events use it.'));
      else section.remove();            // plain scenery: only worth a line when something creates it
      return;
    }
    const shown = refs.slice(0, 200);
    for (const r of shown) {
      const here = r.from === state.path;
      const line = el('div', 'evline');
      const a = el('a', here ? '' : 'maplink',
        (here ? '' : r.from.replace(/^Levels\//, '').replace(/\.zax$/i, '') + ' \u25B8 ') + r.title);
      a.href = '#';
      a.title = here ? 'Select the object' : 'Open that map and select the object';
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (r.from === state.path) select(r.id, true); else openLevel(r.from, { selectId: r.id });
      });
      line.append(a, document.createTextNode(': ' + r.label));
      section.append(line);
    }
    if (refs.length > shown.length) section.append(el('div', 'dim', `...and ${refs.length - shown.length} more.`));
  }, (e) => { section.lastChild.textContent = e.message; });
}

// ---------------------------------------------------------------- properties window

const IDENTITY = ['Name', 'Model', 'Cur Sequence', 'Category', 'Team Number'];
const PLACEMENT = ['Position X', 'Position Y', 'Rendering Height', 'Rendering Height Float', 'Half Height', 'Full Height',
  'Facing Angle', 'Angle', 'Polygon'];
const GAMEPLAY = ['Hit Points', 'Max Hit Points', 'Armor', 'Damage', 'Speed', 'Current Target', 'Targeting Point',
  'Broadcaster', 'Used In'];
const BOOLEAN = /^(Is |Has |Can |Tries |Occludes |Was |Trigger|Auto-|Disable|Visible$|Active$|Collideable$|Stationary$|Full Height$|Half Height$)/;

function propRow(grid, key, value) {
  grid.append(el('div', 'pkey', key), el('div', 'pval', value === '' ? '—' : value));
}

function groupBox(parent, title) {
  const fs = el('fieldset', 'group');
  fs.append(el('legend', '', title));
  parent.append(fs);
  return fs;
}

function buildGeneral(page, o, props) {
  const scal = new Map(props.props.filter(([, v]) => typeof v === 'string'));
  const used = new Set();
  const take = (k) => { used.add(k); return scal.get(k); };

  const top = el('div', 'pgtop');
  const id = groupBox(top, 'Identity');
  const grid = el('div', 'pgrid');
  propRow(grid, 'Class', props.cls);
  for (const k of IDENTITY) if (scal.has(k)) propRow(grid, k, take(k));
  id.append(grid);
  const sp = spriteOf(o);
  if (sp) {
    const pv = el('div', 'preview sunken');
    const cv = el('canvas');
    const s = Math.min(1, 110 / sp.w, 110 / sp.h);
    cv.width = Math.max(1, Math.round(sp.w * s)); cv.height = Math.max(1, Math.round(sp.h * s));
    cv.getContext('2d').drawImage(sp.img, 0, 0, cv.width, cv.height);
    pv.append(cv);
    top.append(pv);
  }
  page.append(top);

  const place = groupBox(page, 'Placement');
  const pg = el('div', 'pgrid');
  for (const k of PLACEMENT) {
    if (!scal.has(k) || BOOLEAN.test(k)) continue;
    const v = take(k);
    propRow(pg, k, k === 'Polygon' ? `${o.polygon ? o.polygon.length : '?'} points` : v);
  }
  if (!pg.children.length) propRow(pg, 'Position', `${Math.round(o.x)}, ${Math.round(o.y)}`);
  place.append(pg);

  const flags = [...scal].filter(([k, v]) => (v === '0' || v === '1') && BOOLEAN.test(k));
  if (flags.length) {
    const st = groupBox(page, 'State');
    const box = el('div', 'checks');
    for (const [k, v] of flags) {
      used.add(k);
      const lab = el('label');
      const cb = el('input');
      cb.type = 'checkbox'; cb.checked = v === '1'; cb.disabled = true;
      lab.append(cb, document.createTextNode(k));
      box.append(lab);
    }
    st.append(box);
  }

  const game = [...GAMEPLAY].filter((k) => scal.has(k) && !used.has(k));
  if (game.length) {
    const g = groupBox(page, 'Gameplay');
    const gg = el('div', 'pgrid');
    for (const k of game) {
      const v = take(k);
      propRow(gg, k, k === 'Used In' ? v.split(',').map((x) => x.split('/').pop()).join(', ') : v);
    }
    g.append(gg);
  }

  const rest = [...scal].filter(([k]) => !used.has(k));
  const filled = rest.filter(([, v]) => v !== '');
  const empty = rest.filter(([, v]) => v === '');
  const nested = props.props.filter(([, v]) => typeof v !== 'string');
  if (filled.length || nested.length || empty.length) {
    const ot = groupBox(page, 'Other');
    const og = el('div', 'pgrid');
    for (const [k, v] of filled) propRow(og, k, v);
    for (const [k, v] of nested) {
      const count = v.props.find(([kk]) => kk === 'Item Count');
      propRow(og, k, v.cls === 'Array' ? `${count ? count[1] : v.props.length} item(s)` : `${v.cls} object`);
    }
    ot.append(og);
    if (empty.length) ot.append(el('div', 'dim small', 'Empty: ' + empty.map(([k]) => k).join(', ')));
  }
}

function buildTree(parent, node, key) {
  const d = el('details');
  if (!key) d.open = true;
  const count = node.props.find(([k]) => k === 'Item Count');
  d.append(el('summary', '', (key ? key + ' = ' : '') + (node.cls || '{}') +
    (node.cls === 'Array' && count ? ` (${count[1]} items)` : '')));
  const body = el('div', 'tbody');
  for (const [k, v] of node.props) {
    if (typeof v === 'string') {
      const row = el('div', 'trow');
      row.append(el('span', 'pkey', k), document.createTextNode(' = ' + v));
      body.append(row);
    } else buildTree(body, v, k);
  }
  for (const r of node.raw) body.append(el('div', 'trow mono', r));
  d.append(body);
  parent.append(d);
}

async function openObjectWindow(id) {
  const o = state.level.objects[id];
  const w = createWindow(`${objectTitle(o)} - ${o.cls}`, { key: state.path + '|' + id });
  if (!w) return;
  w.body.append(el('div', 'dim', 'Loading...'));
  let props;
  try {
    props = await api(`/api/objectprops?path=${encodeURIComponent(state.path)}&id=${id}`);
  } catch (e) {
    w.body.textContent = e.message;
    return;
  }
  w.body.textContent = '';
  const tabs = [{ name: 'General', build: (p) => buildGeneral(p, o, props) }];
  if (o.events.length) tabs.push({ name: 'Events', build: (p) => { p.classList.add('scroll'); renderEvents(p, o); } });
  tabs.push({
    name: 'Links',
    build: (p) => {
      p.classList.add('scroll');
      const out = [];
      for (const e of o.events) walkEvent(e, (n) => {
        for (const r of n.refs) out.push([n.label, refLink(r)]);
        if (n.map) out.push([n.label, mapLink(n.map.name, n.map.location)]);
        for (const r of n.remote || []) out.push([n.label, mapLink(r.map, r.name)]);
        if (n.dialog) out.push([n.label, dialogLink(n.dialog)]);
      });
      if (out.length) {
        p.append(el('div', 'caption', 'Acts on'));
        for (const [label, link] of out) {
          const line = el('div', 'evline');
          line.append(link, document.createTextNode('  (' + label + ')'));
          p.append(line);
        }
      }
      renderIncoming(p, o);
      if (!p.children.length) p.append(el('div', 'dim', 'No links to or from this object.'));
    },
  });
  tabs.push({ name: 'All properties', build: (p) => { p.classList.add('scroll', 'tree'); buildTree(p, props, ''); } });
  tabs.push({
    name: 'Source',
    build: async (p) => {
      const pre = el('pre', 'sunken source', 'Loading...');
      p.append(pre);
      pre.textContent = await api(`/api/object?path=${encodeURIComponent(state.path)}&id=${id}`, 'text');
    },
  });
  makeTabs(w.body, tabs);
}
