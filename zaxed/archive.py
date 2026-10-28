"""Read access to Zax: The Alien Hunter's DATA.dat.

DATA.dat is a ZIP archive (entries stored, not compressed) whose
end-of-central-directory signature is 'RE\\x05\\x06' instead of 'PK\\x05\\x06'.
Reads go through a wrapper that presents the standard signature, so the
standard zipfile module can open it without the file being changed.
"""
import io
import threading
import zipfile


class _FixedSignature(io.RawIOBase):
    """File view of DATA.dat with the end-of-central-directory signature fixed."""

    def __init__(self, path):
        self._f = open(path, 'rb')
        self._f.seek(0, io.SEEK_END)
        size = self._f.tell()
        tail_start = max(0, size - 70000)
        self._f.seek(tail_start)
        found = self._f.read().rfind(b'RE\x05\x06')
        if found < 0:
            raise ValueError(f'{path}: no RE end-of-central-directory record, not a Zax DATA.dat')
        self._eocd = tail_start + found
        self._f.seek(0)

    def readable(self):
        return True

    def seekable(self):
        return True

    def seek(self, offset, whence=io.SEEK_SET):
        return self._f.seek(offset, whence)

    def tell(self):
        return self._f.tell()

    def readinto(self, buf):
        pos = self._f.tell()
        n = self._f.readinto(buf)
        for i, byte in enumerate(b'PK'):
            at = self._eocd + i - pos
            if 0 <= at < n:
                buf[at] = byte
        return n

    def close(self):
        self._f.close()
        super().close()


class DataArchive:
    """Thread-safe reader for DATA.dat (zipfile objects aren't)."""

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._zip = zipfile.ZipFile(io.BufferedReader(_FixedSignature(path), 1 << 20))
        # lookups are case-insensitive, as on Windows
        self._names = {info.filename.lower(): info.filename for info in self._zip.infolist()}

    def names(self):
        return list(self._names.values())

    def exists(self, name):
        return name.lower() in self._names

    def real_name(self, name):
        """The archive's spelling of a name (lookups ignore case), or None."""
        return self._names.get(name.lower())

    def read(self, name):
        real = self._names.get(name.lower())
        if real is None:
            raise KeyError(name)
        with self._lock:
            return self._zip.read(real)
