"""Mission dialogue scripts (Levels/<Script>.RDS) and cross-map references.

RDS: plain text, entries separated by label lines:
    :01 Zelon about Auto Map
    Zelon: You can display the auto map ...
    Zax: (another speaker's line)
CZaxDialogAction(Script=ACT 1/M1M2/Mission01n2, Line=<label>) shows one
entry; its voice is Levels/<script dir>/VOs/<label>.ogg (or .wav).
"""
import re
import threading

from . import zaxfile


def map_path(archive, name):
    """Level file for a map name as used in actions ('ACT 1/M1m2/01 TargDens',
    'Inside Ship'), or None."""
    return archive.real_name(f'Levels/{name}.zax')


def dialog(archive, script, line):
    """{'script', 'line', 'entries': [{'speaker', 'text'}], 'voice': path or None}."""
    text = archive.read(f'Levels/{script}.RDS').decode('latin1')
    entries = []
    found = False
    for raw in re.split(r'\r?\n', text):
        if raw.startswith(':'):
            if found:
                break
            found = raw[1:].strip().lower() == line.strip().lower()
            continue
        if found and raw.strip():
            speaker, _, said = raw.partition(':')
            entries.append({'speaker': speaker.strip(), 'text': said.strip()} if said else
                           {'speaker': '', 'text': raw.strip()})
    folder = script.rsplit('/', 1)[0] if '/' in script else ''
    voice = None
    for ext in ('ogg', 'wav'):
        voice = archive.real_name(f'Levels/{folder}/VOs/{line}.{ext}' if folder else f'Levels/VOs/{line}.{ext}')
        if voice:
            break
    return {'script': script, 'line': line, 'found': found, 'entries': entries, 'voice': voice}


def item_definitions(archive):
    """Names of inventory item definitions ('Bullets', 'Shields/Shield Level 1'),
    lower case: Inventory/Item Definitions/<name>.txt."""
    prefix = 'inventory/item definitions/'
    return {n.lower()[len(prefix):-4] for n in archive.names()
            if n.lower().startswith(prefix) and n.lower().endswith('.txt')}


class CrossRefs:
    """Game-wide event index, built once in the background on first use:
    events in other maps that lead into a map (map switches, teleports,
    actions run in another map), and events in any map that use an inventory
    item (check / give / use...) or create a model."""

    def __init__(self, archive):
        self.archive = archive
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self._started = False
        self._index = {}         # target level path (lower) -> [ref]
        self._items = {}         # item definition (lower) -> [ref + 'segments']
        self._models = {}        # model (lower) -> [ref]

    def _build(self):
        index, items, models = {}, {}, {}
        levels = sorted(n for n in self.archive.names() if n.lower().endswith('.zax'))
        for path in levels:
            try:
                summary, _, _ = zaxfile.level_summary(self.archive.read(path).decode('latin1'))
            except Exception:       # a broken level shouldn't stop the index
                continue
            for obj in summary['objects']:
                title = obj['name'] or (obj['model'].split('/')[-1] if obj['model'] else obj['cls'])
                stack = list(obj['events'])
                while stack:
                    e = stack.pop()
                    stack.extend(e['children'])
                    ref = {'from': path, 'id': obj['id'], 'title': title, 'label': e['label']}
                    for item in e.get('items', []):
                        items.setdefault(item['def'].lower(), []).append(dict(ref, segments=item['segments']))
                    for m in e.get('models', []):
                        models.setdefault(m.lower(), []).append(ref)
                    targets = []
                    if 'map' in e:
                        targets.append((e['map']['name'], e['map']['location']))
                    for r in e.get('remote', []):
                        targets.append((r['map'], r['name']))
                    for map_name, location in targets:
                        target = map_path(self.archive, map_name)
                        if not target or target.lower() == path.lower():
                            continue
                        index.setdefault(target.lower(), []).append({
                            'from': path, 'id': obj['id'], 'title': title,
                            'label': e['label'], 'location': location})
        with self._lock:
            self._index = index
            self._items = items
            self._models = models
        self._ready.set()

    def start(self):
        with self._lock:
            if self._started:
                return
            self._started = True
        threading.Thread(target=self._build, daemon=True).start()

    def get(self, path, timeout=60):
        self.start()
        self._ready.wait(timeout)
        with self._lock:
            return self._index.get(path.lower(), [])

    def item_users(self, definition='', segment='', model='', timeout=60):
        """Events anywhere in the game that use an item definition (segment
        given: events naming other segments of it are left out) or create a
        model, in map order."""
        self.start()
        self._ready.wait(timeout)
        with self._lock:
            out = []
            for r in self._items.get(definition.lower(), []) if definition else []:
                if segment and r['segments'] and segment.lower() not in (x.lower() for x in r['segments']):
                    continue
                out.append(dict(r, kind='item'))
            for r in self._models.get(model.lower(), []) if model else []:
                out.append(dict(r, kind='model'))
        out.sort(key=lambda r: (r['from'], r['id']))
        return out
