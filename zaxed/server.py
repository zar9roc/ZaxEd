"""Local HTTP server for the Zax map editor UI (localhost only, read-only).

API (all GET):
  /api/levels                 level file names in DATA.dat
  /api/level?path=P           level summary: info, terrain grid, objects (JSON)
  /api/object?path=P&id=N     original text of one object (text/plain)
  /api/texture?name=T         terrain texture T: 4-byte header (uint16 w, h)
                              followed by w*h RGB565 pixels, little-endian
  /api/wait?ms=N              empty GIF after N ms (max 10 s); lets headless
                              browsers screenshot after the map has loaded
Everything else is served from the web/ directory.
"""
import json
import mimetypes
import os
import struct
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import zaxfile

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web')

FRM16_HEADER = 36     # .frm16: 36-byte header, w*h RGB565, then 512 trailing bytes


class LevelCache:
    """Parsed levels, so object text can be served without reparsing."""

    def __init__(self, archive):
        self.archive = archive
        self._lock = threading.Lock()
        self._levels = {}

    def get(self, path):
        with self._lock:
            if path not in self._levels:
                text = self.archive.read(path).decode('latin1')
                self._levels = {path: zaxfile.level_summary(text)}     # keep only the latest
            return self._levels[path]


def make_handler(archive):
    levels = LevelCache(archive)

    class Handler(BaseHTTPRequestHandler):
        server_version = 'ZaxEd/0.1'

        def log_message(self, fmt, *args):
            pass

        def _send(self, status, body, ctype):
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj):
            self._send(200, json.dumps(obj, separators=(',', ':')).encode(), 'application/json')

        def _error(self, status, message):
            self._send(status, message.encode(), 'text/plain; charset=utf-8')

        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            try:
                if url.path == '/api/levels':
                    names = sorted(n for n in archive.names() if n.lower().endswith('.zax'))
                    return self._json(names)
                if url.path == '/api/level':
                    summary, _ = levels.get(q['path'])
                    return self._json(summary)
                if url.path == '/api/object':
                    summary, lines = levels.get(q['path'])
                    obj = summary['objects'][int(q['id'])]
                    text = '\n'.join(lines[obj['first_line']:obj['last_line'] + 1])
                    return self._send(200, text.encode('utf-8'), 'text/plain; charset=utf-8')
                if url.path == '/api/texture':
                    data = archive.read(f"Cache/Textures/{q['name']}.frm16")
                    w, h = struct.unpack_from('<HH', data, 6)
                    pixels = data[FRM16_HEADER:FRM16_HEADER + w * h * 2]
                    return self._send(200, struct.pack('<HH', w, h) + pixels, 'application/octet-stream')
                if url.path == '/api/wait':
                    time.sleep(min(int(q.get('ms', '0')), 10000) / 1000)
                    return self._send(200, b'GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'image/gif')
                return self._static(url.path)
            except KeyError as e:
                return self._error(404, f'not found: {e}')
            except (ValueError, IndexError) as e:
                return self._error(400, f'bad request: {e}')

        def _static(self, path):
            rel = os.path.normpath(urllib.parse.unquote(path).lstrip('/') or 'index.html')
            full = os.path.join(WEB_DIR, rel)
            if rel.startswith('..') or not os.path.isfile(full):
                return self._error(404, 'not found')
            with open(full, 'rb') as f:
                body = f.read()
            ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
            if ctype.startswith('text/') or ctype == 'application/javascript':
                ctype += '; charset=utf-8'
            return self._send(200, body, ctype)

    return Handler


def serve(archive, port):
    httpd = ThreadingHTTPServer(('127.0.0.1', port), make_handler(archive))
    return httpd
