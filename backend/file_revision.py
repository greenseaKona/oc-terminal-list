"""Content revisions and replacement writes which leave the original intact on failure."""
from __future__ import annotations

import hashlib
import os
import stat
import tempfile
import threading
from _thread import LockType
from pathlib import Path
from weakref import WeakValueDictionary

import anyio

_registry_lock = threading.Lock()
_local_locks: WeakValueDictionary[str, LockType] = WeakValueDictionary()
_remote_locks: WeakValueDictionary[tuple[str, str], anyio.Lock] = WeakValueDictionary()


class FileRevisionConflictError(Exception):
    """The file has changed since the editor read it."""


def content_revision(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_write(path: Path, data: bytes, expected_revision: str | None) -> None:
    """Stage bytes beside the destination, then check its revision and replace it."""
    key = str(path.resolve())
    with _registry_lock:
        lock = _local_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _local_locks[key] = lock
    with lock:
        _atomic_write_locked(path, data, expected_revision)


def remote_write_lock(host_id: str, path: str) -> anyio.Lock:
    """Keep competing application uploads serialized without retaining idle locks."""
    key = (host_id, path)
    with _registry_lock:
        lock = _remote_locks.get(key)
        if lock is None:
            lock = anyio.Lock()
            _remote_locks[key] = lock
    return lock


def _atomic_write_locked(path: Path, data: bytes, expected_revision: str | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".iterm-write-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            info = path.stat()
        except FileNotFoundError:
            if expected_revision is not None:
                raise FileRevisionConflictError from None
        else:
            if expected_revision is not None:
                with path.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != expected_revision:
                        raise FileRevisionConflictError
            temporary.chmod(stat.S_IMODE(info.st_mode))
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
