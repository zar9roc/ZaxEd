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


def objects(root):
    """All positioned objects (entities): flat list with the essentials."""
    result = []
    parents = {}
    for node in root.walk():
        for _, v in node.props:
            if isinstance(v, Node):
                parents[id(v)] = node
    for node in root.walk():
        scal = node.scalars()
        if 'Position X' not in scal or 'Position Y' not in scal:
            continue
        try:
            x = float(scal['Position X'])
            y = float(scal['Position Y'])
        except ValueError:
            continue
        model = scal.get('Model', '')
        parent = parents.get(id(node))
        result.append({
            'id': len(result),
            'cls': node.cls,
            'name': scal.get('Name', ''),
            'model': model,
            'category': model.split('/', 1)[0] if model else '(none)',
            'x': x,
            'y': y,
            'visible': _flag(scal, 'Visible'),
            'active': _flag(scal, 'Active'),
            'stationary': _flag(scal, 'Stationary', False),
            'container': parent.key if parent else '',
            'first_line': node.first_line,
            'last_line': node.last_line,
        })
    return result


# root properties shown in the level info panel
INFO_KEYS = ('Map Description', 'Width', 'Height', 'Environment Type', 'Default Game Type',
             'Suggested Num Players', 'Max Players', 'Partial File Name', 'View Position',
             'Disable Mini-Map')


def level_summary(text):
    """Everything the viewer needs about a level, JSON-ready."""
    root, lines = parse(text)
    scal = root.scalars()
    info = {k: scal[k] for k in INFO_KEYS if k in scal}
    return {
        'class': root.cls,
        'width': int(float(scal.get('Width', '0') or 0)),
        'height': int(float(scal.get('Height', '0') or 0)),
        'info': info,
        'terrain': terrain(root),
        'objects': objects(root),
    }, lines
