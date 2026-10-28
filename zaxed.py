#!/usr/bin/env python3
"""ZaxEd - map viewer/editor for Zax: The Alien Hunter.

Usage: zaxed.py [--data PATH/TO/DATA.dat] [--port N] [--no-browser]

Starts a local web server (127.0.0.1 only) and opens the editor in the
browser. The game's DATA.dat is only read, never changed.
"""
import argparse
import glob
import os
import sys
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from zaxed.archive import DataArchive  # noqa: E402
from zaxed.server import serve  # noqa: E402

# where a Steam (Proton) install of the Zomb's Lair edition puts the game
DEFAULT_GLOBS = [
    '~/.local/share/Steam/steamapps/compatdata/*/pfx/drive_c/Games/*/Zax - The Alien Hunter/Game/DATA.dat',
    '~/.local/share/Steam/steamapps/common/*/Game/DATA.dat',
]


def find_data():
    for pattern in DEFAULT_GLOBS:
        found = sorted(glob.glob(os.path.expanduser(pattern)))
        if found:
            return found[0]
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--data', help='path to the game\'s DATA.dat (found automatically if omitted)')
    ap.add_argument('--port', type=int, default=8642)
    ap.add_argument('--no-browser', action='store_true', help='don\'t open the browser')
    args = ap.parse_args()

    data = args.data or find_data()
    if not data or not os.path.isfile(data):
        sys.exit('DATA.dat not found; pass --data /path/to/Zax/Game/DATA.dat')
    archive = DataArchive(data)
    httpd = serve(archive, args.port)
    url = f'http://127.0.0.1:{args.port}/'
    print(f'ZaxEd: {data}\nserving {url}  (Ctrl+C to stop)')
    if not args.no_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
