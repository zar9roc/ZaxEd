"""Parser for Zax level files (.zax) and other files in the engine's text format.

The format is the engine's property serialisation, CRLF lines, tab-indented:

    CLayerSaveData            <- root class name
    {
        Width=5000            <- scalar property
        Music Mix=CMusicMixerData
        {                     <- the value above is an object of that class
            ...
        }
        Fog Of War=CFrame(1,1,8)
        {
            01                <- raw data lines (no '=')
        }
    }

Nodes keep the line range they came from, so the original text of any object
can be shown (and later edited) exactly.
"""
import re


class Node:
    __slots__ = ('key', 'cls', 'props', 'raw', 'first_line', 'last_line')

    def __init__(self, key, cls, first_line):
        self.key = key              # property name this object is stored under
        self.cls = cls              # class name, e.g. CEntityBase
        self.props = []             # [(key, str or Node)] in file order
        self.raw = []               # raw data lines (no '=')
        self.first_line = first_line
        self.last_line = first_line

    def get(self, key, default=None):
        for k, v in self.props:
            if k == key:
                return v
        return default

    def scalars(self):
        return {k: v for k, v in self.props if isinstance(v, str)}

    def walk(self):
        yield self
        for _, v in self.props:
            if isinstance(v, Node):
                yield from v.walk()


def parse(text):
    """Parse engine text format into a Node tree (root key is '')."""
    lines = text.split('\r\n') if '\r\n' in text else text.split('\n')
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    root = Node('', lines[i].strip(), i)
    stack = []
    pending = root          # object waiting for its '{'
    for n in range(i + 1, len(lines)):
        s = lines[n].strip()
        if s == '{':
            if pending is None:     # '{' after a scalar: anonymous block
                pending = Node('', '', n)
                if stack:
                    stack[-1].props.append(('', pending))
            stack.append(pending)
            pending = None
            continue
        if s == '}':
            if stack:
                stack.pop().last_line = n
            pending = None
            continue
        if not s or not stack:
            continue
        parent = stack[-1]
        if '=' in s:
            key, value = s.split('=', 1)
            # a value becomes an object if the next non-empty line is '{'
            nxt = n + 1
            while nxt < len(lines) and not lines[nxt].strip():
                nxt += 1
            if nxt < len(lines) and lines[nxt].strip() == '{':
                node = Node(key, value, n)
                parent.props.append((key, node))
                pending = node
            else:
                parent.props.append((key, value))
                pending = None
        else:
            parent.raw.append(s)
            pending = None
    return root, lines


_ELEVATION_ROW = re.compile(r'Elevations Row (\d+)$')


def terrain(root):
    """Terrain of a level: texture names and the elevation grid (one byte per
    64-px tile corner; value 0..255 blends through the textures in order)."""
    ground = root.get('Plasma Ground')
    if not isinstance(ground, Node):
        return None
    scal = ground.scalars()
    count = int(scal.get('Num Textures', '0'))
    textures = [scal.get(f'Texture {i}', '') for i in range(count)]
    rows = []
    for key, value in ground.props:
        m = _ELEVATION_ROW.match(key)
        if m and isinstance(value, str):
            rows.append((int(m.group(1)), value))
    rows.sort()
    grid = [[int(hexrow[c:c + 2], 16) for c in range(0, len(hexrow), 2)] for _, hexrow in rows]
    return {
        'blending': float(scal.get('Blending', '0') or 0),
        'textures': textures,
        'rows': len(grid),
        'cols': len(grid[0]) if grid else 0,
        'grid': grid,
    }


def _flag(scal, key, default=True):
    value = scal.get(key)
    return default if value is None else value.strip() == '1'


def _polygon(value):
    """'x, y, x, y, ...' -> [[x, y], ...] or None."""
    try:
        nums = [float(v) for v in value.split(',') if v.strip()]
    except ValueError:
        return None
    if len(nums) < 6 or len(nums) % 2:
        return None
    return [[nums[i], nums[i + 1]] for i in range(0, len(nums), 2)]


def objects(root, nodes=None):
    """All objects: positioned entities and polygon level parts
    (CFreeRangePoly: trigger areas, blockers...), flat, with their events.
    If nodes is a list, each object's Node is appended to it (index = id)."""
    from . import events          # events imports Node from here
    found = []
    parents = {}
    for node in root.walk():
        for _, v in node.props:
            if isinstance(v, Node):
                parents[id(v)] = node
    for node in root.walk():
        scal = node.scalars()
        parent = parents.get(id(node))
        polygon = None
        if 'Position X' in scal and 'Position Y' in scal:
            try:
                x = float(scal['Position X'])
                y = float(scal['Position Y'])
            except ValueError:
                continue
        elif 'Polygon' in scal and parent is not None and node.key == 'Level Part':
            polygon = _polygon(scal['Polygon'])
            if not polygon:
                continue
            x = sum(p[0] for p in polygon) / len(polygon)
            y = sum(p[1] for p in polygon) / len(polygon)
        else:
            continue
        found.append((node, scal, parent, x, y, polygon))

    names = {scal.get('Name', '') for _, scal, _, _, _, _ in found} - {''}
    result = []
    for node, scal, parent, x, y, polygon in found:
        model = scal.get('Model', '')
        evs = events.event_tree(node, names)
        if polygon:
            category = 'Trigger areas' if any('trigger' in e for e in evs) else 'Polygons'
        else:
            category = model.split('/', 1)[0] if model else '(none)'
        obj = {
            'id': len(result),
            'cls': node.cls,
            'name': scal.get('Name', ''),
            'model': model,
            'seq': scal.get('Cur Sequence', ''),
            'category': category,
            'x': x,
            'y': y,
            'visible': _flag(scal, 'Visible'),
            'active': _flag(scal, 'Active'),
            'stationary': _flag(scal, 'Stationary', False),
            'collideable': _flag(scal, 'Collideable', False),
            'full_height': _flag(scal, 'Full Height', False),
            'half_height': _flag(scal, 'Half Height', False),
            'container': parent.key if parent else '',
            'first_line': node.first_line,
            'last_line': node.last_line,
            'events': evs,
        }
        if polygon:
            obj['polygon'] = polygon
        result.append(obj)
        if nodes is not None:
            nodes.append(node)
    return result


# root properties shown in the level info panel
INFO_KEYS = ('Map Description', 'Width', 'Height', 'Environment Type', 'Default Game Type',
             'Suggested Num Players', 'Max Players', 'Partial File Name', 'View Position',
             'Disable Mini-Map')


def level_summary(text):
    """Everything the viewer needs about a level, JSON-ready; also the text
    lines and each object's Node (index = object id)."""
    root, lines = parse(text)
    scal = root.scalars()
    info = {k: scal[k] for k in INFO_KEYS if k in scal}
    nodes = []
    return {
        'class': root.cls,
        'width': int(float(scal.get('Width', '0') or 0)),
        'height': int(float(scal.get('Height', '0') or 0)),
        'info': info,
        'terrain': terrain(root),
        'objects': objects(root, nodes),
    }, lines, nodes


def node_json(node):
    """A Node as plain data: {"cls", "props": [[key, str | node]], "raw"}."""
    return {
        'cls': node.cls,
        'props': [[k, v if isinstance(v, str) else node_json(v)] for k, v in node.props],
        'raw': node.raw,
    }
