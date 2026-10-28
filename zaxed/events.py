"""Readable summaries of a level's scripting ("events").

Objects carry an `Activity` array of AI components. Triggers
(CTouchingPolygonTriggerAI on a CFreeRangePoly, CTouchingOvalTriggerAI with
X Radius / YX Ratio, CPassThroughTriggerAI, CollideTriggerAI) run Enter /
Exit / Repeat actions; CRelayAI listens for CTriggerRelayAction(Relay Name =
the relay object's name); other AIs can run actions too (Done action, Spawn
Action, End of path action...). Actions nest (CMultipleActionsAction,
CSeriesAction, CConditionalAction with Try / Succeed / Fail, CDelayAction...)
and point at other objects by name (Target Name, Relay Name, New Location...).

event_tree() turns an object's activities into nested
    {"label": str, "cls": str, "key": str, "refs": [name...],
     "trigger": {...} (triggers only), "children": [...]}
References are found from the data: any value inside an event that equals the
name of an object in the level.
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


def _label(node):
    """One-line description of an action or AI node."""
    c, s = node.cls, node.scalars()
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
    if c == 'CSwitchMapAction':
        return f"Switch map to {s.get('New Map Name', '')} at '{s.get('New Location', '')}'"
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
    """Object names this node itself refers to (not its children)."""
    found = []
    for k, v in node.props:
        if isinstance(v, str) and v in names and k not in ('Name',) and v not in found:
            found.append(v)
    return found


def _action(node, key, names, depth=0):
    if depth > 40:
        return None
    entry = {'label': _label(node), 'cls': node.cls, 'key': key, 'refs': _refs(node, names), 'children': []}
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
                    child = _action(iv, k, names, depth + 1)
                    if child:
                        entry['children'].append(child)
        elif k in ACTION_KEYS or 'Action' in v.cls or v.cls.endswith('AI') or k.endswith(' AI'):
            child = _action(v, k, names, depth + 1)
            if child:
                entry['children'].append(child)
    return entry


def _has_events(entry):
    """True if the tree does anything worth listing as an event."""
    if entry.get('trigger') or entry['cls'] == 'CRelayAI' or entry['refs']:
        return True
    if 'Action' in entry['cls'] and entry['cls'] not in ('CMultipleActionsAction', 'CSeriesAction'):
        return True
    return any(_has_events(c) for c in entry['children'])


def event_tree(obj_node, names):
    """Event trees of one object's activities (only those that do something)."""
    activity = obj_node.get('Activity')
    if not isinstance(activity, Node):
        return []
    out = []
    for key, ai in activity.props:
        if isinstance(ai, Node) and ai.cls:
            entry = _action(ai, key, names)
            if entry and _has_events(entry):
                out.append(entry)
    return out
