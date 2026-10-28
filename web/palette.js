'use strict';
// ZaxEd object palette (like the Heroes 3 map editor's): every model in the
// game, grouped by category buttons, area and folder, with lazily loaded
// thumbnails. Selecting a model highlights its instances on the map.
// Uses globals from app.js / windows.js at call time.

const palette = {
  models: null,           // all model names
  cat: null,              // selected category (first path segment)
  area: '',               // second-level filter ('' = all)
  search: '',
  selected: null,         // selected model name
  instances: [],          // ids of the selected model's objects on the map
  cursor: -1,
  observer: null,
};

const CATEGORY_ORDER = ['Environments', 'Items', 'Characters', 'Special Effects', 'Particles', 'Explosions',
  'Multiplayer', 'Editor', 'Gibs', 'UI'];

async function initPalette() {
  if (palette.models) return;
  palette.models = await api('/api/models');
  const counts = {};
  for (const m of palette.models) {
    const c = m.split('/')[0];
    counts[c] = (counts[c] || 0) + 1;
  }
  const cats = Object.keys(counts).sort((a, b) =>
    ((CATEGORY_ORDER.indexOf(a) + 1) || 99) - ((CATEGORY_ORDER.indexOf(b) + 1) || 99) || a.localeCompare(b));
  palette.cat = store.get('palette.cat', cats[0]);
  if (!counts[palette.cat]) palette.cat = cats[0];
  const bar = $('#palcats');
  bar.innerHTML = '';
  for (const c of cats) {
    const b = el('button', 'palcat', `${c} ${counts[c]}`);
    b.dataset.cat = c;
    b.title = `${c}: ${counts[c]} models`;
    b.addEventListener('click', () => {
      palette.cat = c;
      palette.area = '';
      store.set('palette.cat', c);
      buildPalette();
    });
    bar.append(b);
  }
  $('#palarea').addEventListener('change', (e) => { palette.area = e.target.value; buildPaletteGrid(); });
  $('#palsearch').addEventListener('input', (e) => { palette.search = e.target.value.toLowerCase(); buildPaletteGrid(); });
  $('#palprev').addEventListener('click', () => cycleInstance(-1));
  $('#palnext').addEventListener('click', () => cycleInstance(1));
  palette.observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      palette.observer.unobserve(img);
      img.src = img.dataset.src;
    }
  }, { root: $('#palgrid'), rootMargin: '200px' });
  buildPalette();
}

function buildPalette() {
  for (const b of $$('.palcat')) b.classList.toggle('on', b.dataset.cat === palette.cat);
  // areas: second path segment of models with deeper paths (Jungle, Cave...)
  const areas = [...new Set(palette.models
    .filter((m) => m.split('/')[0] === palette.cat && m.split('/').length > 2)
    .map((m) => m.split('/')[1]))].sort();
  const sel = $('#palarea');
  sel.innerHTML = '';
  sel.append(new Option(areas.length ? 'All areas' : '-', ''));
  for (const a of areas) sel.append(new Option(a, a));
  sel.disabled = !areas.length;
  sel.value = palette.area;
  buildPaletteGrid();
}

function modelUsage() {
  const use = new Map();
  if (state.level)
    for (const o of state.level.objects) if (o.model) use.set(o.model.toLowerCase(), (use.get(o.model.toLowerCase()) || 0) + 1);
  return use;
}

function buildPaletteGrid() {
  const grid = $('#palgrid');
  grid.innerHTML = '';
  if (!palette.models) return;
  const use = modelUsage();
  const groups = new Map();
  for (const m of palette.models) {
    const parts = m.split('/');
    if (parts[0] !== palette.cat) continue;
    if (palette.area && parts[1] !== palette.area) continue;
    if (palette.search && !m.toLowerCase().includes(palette.search)) continue;
    const folder = parts.slice(1, -1).join(' / ') || palette.cat;
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(m);
  }
  const frag = document.createDocumentFragment();
  for (const [folder, models] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    frag.append(el('div', 'palhead', `${folder} (${models.length})`));
    const tiles = el('div', 'paltiles');
    for (const m of models) {
      const tile = el('div', 'paltile' + (m === palette.selected ? ' sel' : ''));
      tile.dataset.model = m;
      const name = m.split('/').pop();
      tile.title = m;
      const img = el('img');
      img.alt = '';
      img.dataset.src = `/api/sprite?model=${encodeURIComponent(m)}&seq=`;
      img.addEventListener('error', () => tile.classList.add('noimg'));
      palette.observer.observe(img);
      const n = use.get(m.toLowerCase());
      if (n) tile.append(el('span', 'paluse', String(n)));
      tile.append(img, el('span', 'palname', name));
      tile.addEventListener('click', () => selectPaletteModel(m));
      tile.addEventListener('dblclick', () => { selectPaletteModel(m); cycleInstance(1); });
      tiles.append(tile);
    }
    frag.append(tiles);
  }
  if (!groups.size) frag.append(el('div', 'dim', 'No models match.'));
  grid.append(frag);
}

function selectPaletteModel(m) {
  palette.selected = palette.selected === m ? null : m;
  for (const t of $$('.paltile')) t.classList.toggle('sel', t.dataset.model === palette.selected);
  refreshPaletteInstances();
  redraw();
}

// Instances of the selected model on the open map (call after a map loads).
function refreshPaletteInstances() {
  const m = palette.selected;
  palette.instances = m && state.level
    ? state.level.objects.filter((o) => o.model.toLowerCase() === m.toLowerCase()).map((o) => o.id)
    : [];
  palette.cursor = -1;
  const info = $('#palinfo');
  if (!m) info.textContent = 'Click a model to find it on the map.';
  else info.textContent = `${m.split('/').pop()}: ${palette.instances.length ? palette.instances.length + ' on this map' : 'not used on this map'}`;
  $('#palprev').disabled = $('#palnext').disabled = !palette.instances.length;
}

function cycleInstance(step) {
  if (!palette.instances.length) return;
  palette.cursor = (palette.cursor + step + palette.instances.length) % palette.instances.length;
  select(palette.instances[palette.cursor], true);
  $('#palinfo').textContent = `${palette.selected.split('/').pop()}: ${palette.cursor + 1} of ${palette.instances.length} on this map`;
}

// Map overlay: a box around every instance of the selected model.
function drawPaletteHighlight(ctx, sx, sy, z) {
  if (!palette.selected || !palette.instances.length) return;
  ctx.strokeStyle = '#ffff00';
  ctx.lineWidth = 2;
  for (const id of palette.instances) {
    const o = state.level.objects[id];
    const s = spriteOf(o);
    if (s && drawsSprite(o)) ctx.strokeRect(sx(o.x - s.hx) - 1, sy(o.y - s.hy) - 1, s.w * z + 2, s.h * z + 2);
    else { ctx.beginPath(); ctx.arc(sx(o.x), sy(o.y), 9, 0, Math.PI * 2); ctx.stroke(); }
  }
}
