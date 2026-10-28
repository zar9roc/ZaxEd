"""Readable summaries of a level's scripting ("events").

Objects carry an `Activity` array of AI components, and can have actions of
their own: `Destroyed Action` (750 objects in the game, e.g. a spawn pad's
power source sends the message "turn gen off" to the pad's CGeneratorAI),
`Damaged Action`, `Collided While Rotating Action`. Triggers
(CTouchingPolygonTriggerAI on a CFreeRangePoly, CTouchingOvalTriggerAI with
X Radius / YX Ratio, CPassThroughTriggerAI, CollideTriggerAI) run Enter /
Exit / Repeat actions; CRelayAI listens for CTriggerRelayAction(Relay Name =
the relay object's name); other AIs can run actions too (Done action, Spawn
Action, End of path action...). Actions nest (CMultipleActionsAction,
CSeriesAction, CConditionalAction with Try / Succeed / Fail, CDelayAction...)
and point at other objects by name (Target Name, Relay Name, New Location...).

event_tree() turns an object's activities into nested
    {"label": str, "cls": str, "key": str, "refs": [name...],
     "trigger": {...}       triggers only
     "map": {"name", "location"}       actions that go to another map
     "dialog": {"script", "line"}      CZaxDialogAction
     "remote": [{"map", "name"}]       names in another map (see below)
     "children": [...]}
References are found from the data: any value inside an event that equals the
name of an object in the level. Inside COtherMapAction (Other Map Name), the
nested actions run in that other map, so their names (REMOTE_KEYS) refer to
objects there and are reported as "remote" instead.
"""
from .zaxfile import Node

TRIGGER_KINDS = {
    'CTouchingPolygonTriggerAI': 'Polygon trigger',
    'CTouchingOvalTriggerAI': 'Oval trigger',
    'CPassThroughTriggerAI': 'Pass-through trigger',
    'CollideTriggerAI': 'Collision trigger',
}
# keys of nested actions, in the order they should be shown
ACTION_KEYS = ('Enter Action', 'Exit Action', 'Repeat Action', 'Action', 'Try Action', 'Succeed Action',
               'Fail Action', 'Next Action', 'Done action', 'Spawn Action', 'End of path action',
               'Execute After Action')
# keys naming objects; used for actions that run in another map
REMOTE_KEYS = ('Target Name', 'Relay Name', 'New Location', 'New Compass Target', 'Triggered By Name')
# scalar keys that are bookkeeping, not worth showing
NOISE = {'Marked For Deletion', 'Broadcaster', 'Was Triggered', 'Next Repeat Time', 'Next Action Index',
         'AI Instigator', 'AI Trigger', 'Touching LayerPart', 'Item Count'}


def _short(cls):
    name = cls[1:] if cls.startswith('C') and cls[1:2].isupper() else cls
    for suffix in ('Action', 'AI'):
        if name.endswith(suffix) and len(name) > len(suffix):
            name = name[:-len(suffix)]
    out = []
    for i, ch in enumerate(name):         # CamelCase -> words
        if i and ch.isupper() and not name[i - 1].isupper():
            out.append(' ')
        out.append(ch)
    return ''.join(out)


def _who(s):
    who = [w for w, k in (('players', 'Triggered By Players'), ('enemies', 'Triggered By Enemies'),
                          ('projectiles', 'Triggered By Projectiles'), ('anything', 'Triggered By Anything'))
           if s.get(k) == '1']
    if s.get('Triggered By Name'):
        who.append(f"'{s['Triggered By Name']}'")
    return ', '.join(who) or 'nobody'


def _generated_models(node):
    things = node.get('Things to Generate')
    if not isinstance(things, Node):
        return []
    out = []
    for _, t in things.props:
        if isinstance(t, Node) and t.scalars().get('Model'):
            out.append(t.scalars()['Model'].split('/')[-1])
    return out


def _label(node):
    """One-line description of an action or AI node."""
    c, s = node.cls, node.scalars()
    if c == 'CSendMessageAction':
        return f"Send '{s.get('Message', '')}' to '{s.get('Target', '')}'"
    if c == 'CGeneratorAI':
        models = ', '.join(_generated_models(node)) or 'nothing'
        extra = []
        if s.get('Max Simultaneous'):
            extra.append(f"max {s['Max Simultaneous']} at once")
        if s.get('Delay Between Spawns'):
            extra.append(f"every {s['Delay Between Spawns']} s")
        return f"Spawner: {models}" + (f" ({', '.join(extra)})" if extra else '')
    if c in TRIGGER_KINDS:
        text = f"{TRIGGER_KINDS[c]}, by {_who(s)}"
        if s.get('Trigger Only Once') == '1':
            text += ', once'
        if s.get('Repeat Every') not in (None, '', '0'):
            text += f", repeats every {s['Repeat Every']}"
        return text
    if c == 'CRelayAI':
        return 'Relay listener' + (', once' if s.get('Trigger Only Once') == '1' else '')
    if c == 'CZaxDialogAction':
        return f"Dialog: {s.get('Line', '')}" + (f" ({s['Display Type']})" if s.get('Display Type') else '')
    if c == 'CTriggerRelayAction':
        return f"Fire relay '{s.get('Relay Name', '')}'"
    if c in ('CActivateAction', 'CDeactivateAction', 'CDeleteAction', 'CDestroyAction'):
        return f"{_short(c)} '{s.get('Target Name', '')}'"
    if c in ('CSwitchMapAction', 'CTeleportAction'):
        verb = 'Switch map to' if c == 'CSwitchMapAction' else 'Teleport to'
        return f"{verb} {s.get('New Map Name', '')} at '{s.get('New Location', '')}'"
    if c == 'COtherMapAction':
        return f"In map {s.get('Other Map Name', '')}"
    if c == 'CDelayAction':
        delay = next((v for k, v in s.items() if 'Delay' in k or 'Time' in k), '')
        return f"Wait {delay}".strip()
    if c == 'CMultipleActionsAction':
        return 'Do all of'
    if c == 'CSeriesAction':
        return 'Do in order' + (f" (then {s['When Done']})" if s.get('When Done') not in (None, '', 'Do Nothing') else '')
    if c == 'CConditionalAction':
        return 'If'
    # generic: class name and its interesting values
    vals = [f'{k}={v}' for k, v in s.items() if v not in ('', '0') and k not in NOISE]
    return _short(c) + (': ' + ', '.join(vals[:4]) if vals else '')


def _refs(node, names):
    """Object names this node itself refers to (not its children). With a
    New Map Name, New Location names an object in that map, not this one."""
    skip = {'Name'}
    if node.get('New Map Name'):
        skip.add('New Location')
    found = []
    for k, v in node.props:
        if isinstance(v, str) and v in names and k not in skip and v not in found:
            found.append(v)
    return found


def _action(node, key, names, depth=0, other_map=None):
    if depth > 40:
        return None
    s = node.scalars()
    entry = {'label': _label(node), 'cls': node.cls, 'key': key, 'children': [],
             'refs': [] if other_map else _refs(node, names)}
    if other_map:
        remote = [{'map': other_map, 'name': v} for k, v in s.items()
                  if k in REMOTE_KEYS and v and not v.startswith('$')]
        if remote:
            entry['remote'] = remote
    if s.get('New Map Name'):
        entry['map'] = {'name': s['New Map Name'], 'location': s.get('New Location', '')}
    if node.cls == 'COtherMapAction' and s.get('Other Map Name'):
        entry['map'] = {'name': s['Other Map Name'], 'location': ''}
        other_map = s['Other Map Name']
    if node.cls == 'CZaxDialogAction':
        entry['dialog'] = {'script': s.get('Script', ''), 'line': s.get('Line', '')}
    if node.cls in TRIGGER_KINDS:
        s = node.scalars()
        entry['trigger'] = {
            'kind': node.cls,
            'once': s.get('Trigger Only Once') == '1',
            'players': s.get('Triggered By Players') == '1',
            'enemies': s.get('Triggered By Enemies') == '1' or s.get('Triggered By Anything') == '1',
            'radius': float(s['X Radius']) if s.get('X Radius') else None,
            'ratio': float(s['YX Ratio']) if s.get('YX Ratio') else None,
        }
    for k, v in node.props:
        if not isinstance(v, Node) or not v.cls:
            continue
        if v.cls == 'Array':                        # list of actions / AIs
            for ik, iv in v.props:
                if isinstance(iv, Node) and iv.cls:
                    child = _action(iv, k, names, depth + 1, other_map)
                    if child:
                        entry['children'].append(child)
        elif k in ACTION_KEYS or 'Action' in v.cls or v.cls.endswith('AI') or k.endswith(' AI'):
            child = _action(v, k, names, depth + 1, other_map)
            if child:
                entry['children'].append(child)
    return entry


def _has_events(entry):
    """True if the tree does anything worth listing as an event."""
    if entry.get('trigger') or entry['cls'] == 'CRelayAI' or entry['refs'] or 'map' in entry or 'dialog' in entry:
        return True
    if 'Action' in entry['cls'] and entry['cls'] not in ('CMultipleActionsAction', 'CSeriesAction'):
        return True
    return any(_has_events(c) for c in entry['children'])


OBJECT_ACTION_LABELS = {
    'Destroyed Action': 'When destroyed',
    'Damaged Action': 'When damaged',
    'Hit Action': 'When hit',
    'Collided While Rotating Action': 'When it collides while rotating',
}


def event_tree(obj_node, names):
    """Event trees of one object: its activities and its own actions
    (Destroyed Action...), only those that do something."""
    out = []
    activity = obj_node.get('Activity')
    if isinstance(activity, Node):
        for key, ai in activity.props:
            if isinstance(ai, Node) and ai.cls:
                entry = _action(ai, key, names)
                if entry and _has_events(entry):
                    out.append(entry)
    for key, value in obj_node.props:
        if key == 'Activity' or not isinstance(value, Node) or 'Action' not in value.cls:
            continue
        action = _action(value, key, names)
        if action and _has_events(action):
            label = OBJECT_ACTION_LABELS.get(key) or 'On ' + key.replace(' Action', '').lower()
            out.append({'label': label, 'cls': key, 'key': key, 'refs': [], 'children': [action]})
    return out
