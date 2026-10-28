"""Sprites from Zax model files (Cache/Models/<Model>.mdl16).

A model is a binary serialisation of the engine's objects: length-prefixed
strings (u32 length + bytes), floats, nested objects. Its renderable part is a
list of sequences; each sequence is a name ("Idle", "Idle Shadow", ...), a
blend mode string ("Transparent Mask", "Blend Black Bias" for additive glow
overlays, ...) and then its frames, back to back.

Frame (same header as .frm16 textures):
  +0  u16  0x1031 tag
  +2  i16  hotspot x  \\ position of the object's origin inside the image:
  +4  i16  hotspot y  /  draw at (X - hx, Y - hy)
  +6  u16  width
  +8  u16  height
  +16 u32  image size (same as +36)
  +36 u32  image size, counting this field itself; RLE rows follow at +40
RLE, per row until the row is `width` pixels long, control byte c:
  c & 0x80   skip c & 0x7f pixels (transparent)
  c & 0x40   c & 0x3f literal RGB565 pixels follow
  else       the next RGB565 pixel repeated c & 0x3f times
Each model also has one collision outline (see collision()).

After the image: a row offset table (u32 per row, relative to +36), then a
mask and a second image (not used here; "... Shadow" sequences keep their
shadow there, their colour image is empty).

The serialisation around the frames isn't fully decoded, so frames are found
by scanning for the tag and accepted only if the RLE data decodes exactly
(every row ends at the width, all bytes used). Each group of consecutive
frames is labelled with the last two strings before it: sequence name and
blend mode.
"""
import re
import struct
import zlib

FRAME_TAG = b'\x31\x10'
GLOW_BLENDS = ('Blend Black Bias',)
_STRING = re.compile(rb'([\x01-\x7f])\x00\x00\x00([ -~]{2,})')


def decode_rle(data, pos, width, height, size):
    """RGBA bytes of one RLE image, or None if the data doesn't fit exactly."""
    end = pos + size - 4
    if end > len(data):
        return None
    rgba = bytearray(width * height * 4)
    for y in range(height):
        x = 0
        row = y * width
        while x < width:
            if pos >= end:
                return None
            c = data[pos]
            pos += 1
            if c & 0x80:
                x += c & 0x7f
                continue
            n = c & 0x3f
            if c & 0x40:
                if pos + 2 * n > end or x + n > width:
                    return None
                for i in range(n):
                    _put565(rgba, (row + x + i) * 4, data[pos] | data[pos + 1] << 8)
                    pos += 2
            else:
                if pos + 2 > end or x + n > width:
                    return None
                v = data[pos] | data[pos + 1] << 8
                pos += 2
                for i in range(n):
                    _put565(rgba, (row + x + i) * 4, v)
            x += n
        if x != width:
            return None
    return bytes(rgba) if pos == end else None


def _put565(out, o, v):
    r, g, b = v >> 11, (v >> 5) & 63, v & 31
    out[o] = r << 3 | r >> 2
    out[o + 1] = g << 2 | g >> 4
    out[o + 2] = b << 3 | b >> 2
    out[o + 3] = 255


def _frame_at(data, i):
    """(hx, hy, w, h, rgba) if a valid frame starts at offset i."""
    if i + 40 > len(data):
        return None
    hx, hy, w, h = struct.unpack_from('<hhHH', data, i + 2)
    size = struct.unpack_from('<I', data, i + 36)[0]
    if not (0 < w <= 2048 and 0 < h <= 2048 and 4 < size <= len(data) - i - 36):
        return None
    rgba = decode_rle(data, i + 40, w, h, size)
    return None if rgba is None else (hx, hy, w, h, rgba, i + 36 + size)


def first_frames(data):
    """Yield (sequence name, blend mode, (hx, hy, w, h, rgba)) for the first
    frame of each sequence, in file order."""
    pos = 0
    strings_from = 0
    while True:
        i = data.find(FRAME_TAG, pos)
        if i < 0:
            return
        frame = _frame_at(data, i)
        if frame is None:
            pos = i + 1
            continue
        # a real string's length prefix covers its whole printable run
        names = [m.group(2).decode('latin1')
                 for m in _STRING.finditer(data, strings_from, i)
                 if m.group(1)[0] == len(m.group(2))]
        if names:       # strings since the last frame: a new sequence starts here
            name = names[-2] if len(names) >= 2 else names[-1]
            blend = names[-1] if len(names) >= 2 else ''
            yield name, blend, frame[:5]
        pos = strings_from = frame[5]


def sprite(data, wanted=''):
    """Pick the frame to show: the wanted sequence (case-insensitive), else
    "Idle", else the first non-glow, non-shadow sequence.
    Returns (sequence name, (hx, hy, w, h, rgba)) or None.

    "<name> Shadow" sequences exist, but their colour image is empty: the
    shadow lives in the mask / second image after it, not decoded yet."""
    want = (wanted or 'idle').lower()
    seqs = {}
    order = []
    for name, blend, frame in first_frames(data):
        key = name.lower()
        if key not in seqs:
            seqs[key] = (name, blend, frame)
            order.append(key)
        if key == want and blend not in GLOW_BLENDS:
            break
    for key in (want, 'idle'):
        if key in seqs and seqs[key][1] not in GLOW_BLENDS:
            break
    else:
        key = next((k for k in order if seqs[k][1] not in GLOW_BLENDS and not k.endswith(' shadow')), None)
        if key is None:
            return None
    name, _, frame = seqs[key]
    return name, frame


def collision(data):
    """The model's collision outline: 'POLY2D\\0', a type byte (7), u32 point
    count, then x, y float pairs relative to the object's position (closed:
    the last point repeats the first). [] if the model has none."""
    i = data.find(b'POLY2D\x00')
    if i < 0 or i + 12 > len(data):
        return []
    n = struct.unpack_from('<I', data, i + 8)[0]
    if n > 1000 or i + 12 + 8 * n > len(data):
        return []
    return [list(struct.unpack_from('<ff', data, i + 12 + 8 * k)) for k in range(n)]


def is_pickup(data):
    """True if the model's object has a CPickupAI (items, collectable
    scenery): touching it collects it rather than being blocked."""
    return b'\x09\x00\x00\x00CPickupAI' in data


def pickup_item(data, is_definition):
    """Inventory item a pickup model gives: {'def', 'segments'} or None.
    CPickupAI is followed by the item's class, its definition name (an
    Inventory/Item Definitions file; is_definition(name) tells) and, for
    weapon parts, segment names ('MegaFusionDisruptor/fusionbarrell1part')
    up to the next '!' placeholder."""
    i = data.find(b'\x09\x00\x00\x00CPickupAI')
    if i < 0:
        return None
    strings = [m.decode('latin1') for m in re.findall(rb'[ -~]{3,}', data[i + 13:i + 1000])]
    for k, name in enumerate(strings):
        if not name.startswith('!') and is_definition(name):
            segments = []
            for later in strings[k + 1:]:
                if later.startswith('!') or '/' not in later:
                    break
                segments.append(later)
            return {'def': name, 'segments': segments}
    return None


def png(width, height, rgba):
    """Minimal RGBA PNG encoder (no filtering)."""
    def chunk(tag, body):
        c = struct.pack('>I', len(body)) + tag + body
        return c + struct.pack('>I', zlib.crc32(tag + body) & 0xffffffff)
    stride = width * 4
    raw = b''.join(b'\x00' + rgba[y * stride:(y + 1) * stride] for y in range(height))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 6))
            + chunk(b'IEND', b''))
