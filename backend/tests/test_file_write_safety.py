import hashlib
import os
import shlex
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import anyio
import asyncssh
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import host_sftp
import sftp_tailscale
from file_models import FileWriteRequest
from file_revision import FileRevisionConflictError, atomic_write, content_revision
from routes import files_read, files_write


@pytest.mark.asyncio
async def test_stale_local_save_preserves_external_edit(tmp_path, monkeypatch):
    target = tmp_path / "config"
    target.write_bytes(b"external edit")
    monkeypatch.setattr(files_write, "validate_path", lambda *a, **k: target)
    request = FileWriteRequest(path="config", content="my edit",
                               expectedRevision=hashlib.sha256(b"old").hexdigest())
    with pytest.raises(HTTPException) as caught:
        await files_write.write_file(request, "u")
    assert caught.value.status_code == 409
    assert target.read_bytes() == b"external edit"


@pytest.mark.asyncio
async def test_failed_local_replace_preserves_original(tmp_path, monkeypatch):
    target = tmp_path / "config"
    target.write_bytes(b"original")
    monkeypatch.setattr(files_write, "validate_path", lambda *a, **k: target)
    def fail_replace(*args):
        raise OSError("disk failure")
    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(OSError):
        await files_write.write_file(FileWriteRequest(path="config", content="new"), "u")
    assert target.read_bytes() == b"original"
    assert list(tmp_path.iterdir()) == [target]


class DiskSftp:
    def __init__(self, root):
        self.root = root

    def open(self, path, mode):
        @asynccontextmanager
        async def handle():
            with (self.root / path).open(mode.replace("x", "w")) as stream:
                class Handle:
                    async def write(self, data):
                        stream.write(data)
                    async def read(self, size):
                        return stream.read(size)
                yield Handle()
        return handle()

    async def stat(self, path):
        try:
            info = (self.root / path).stat()
        except FileNotFoundError:
            raise asyncssh.SFTPNoSuchFile("missing") from None
        return asyncssh.SFTPAttrs(size=info.st_size, permissions=info.st_mode)

    async def realpath(self, path):
        return path

    async def chmod(self, path, mode):
        (self.root / path).chmod(mode)

    async def posix_rename(self, source, target):
        (self.root / source).replace(self.root / target)

    async def remove(self, path):
        try:
            (self.root / path).unlink()
        except FileNotFoundError:
            raise asyncssh.SFTPNoSuchFile("missing") from None


@pytest.mark.asyncio
async def test_interrupted_sftp_upload_preserves_original(tmp_path, monkeypatch):
    target = tmp_path / "config"
    target.write_bytes(b"original")
    sftp = DiskSftp(tmp_path)
    class Connection:
        @asynccontextmanager
        async def start_sftp_client(self):
            yield sftp
    async def connect(*args):
        return Connection()
    monkeypatch.setattr(host_sftp, "_get_or_open", connect)
    async def chunks():
        yield b"partial"
        raise OSError("connection lost")
    with pytest.raises(host_sftp.HostConnectError):
        await host_sftp.upload_stream({"id": "h"}, {}, "config", chunks(), make_parents=False)
    assert target.read_bytes() == b"original"
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.asyncio
async def test_sftp_save_rejects_edit_during_transfer(tmp_path, monkeypatch):
    target = tmp_path / "config"
    target.write_bytes(b"original")
    target.chmod(0o640)
    sftp = DiskSftp(tmp_path)
    class Connection:
        @asynccontextmanager
        async def start_sftp_client(self):
            yield sftp
    async def connect(*args):
        return Connection()
    monkeypatch.setattr(host_sftp, "_get_or_open", connect)
    async def chunks():
        yield b"my edit"
        target.write_bytes(b"external edit")
    with pytest.raises(FileRevisionConflictError):
        await host_sftp.upload_stream({"id": "h"}, {}, "config", chunks(), make_parents=False,
                                     expected_revision=content_revision(b"original"))
    assert target.read_bytes() == b"external edit"
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.parametrize("complete", [True, False])
def test_tailscale_upload_protocol_requires_complete_transfer(tmp_path, complete):
    target = tmp_path / "config"
    target.write_bytes(b"original")
    target.chmod(0o640)
    data = b"new bytes"
    framed = len(data).to_bytes(8, "big") + data + (bytes(8) if complete else b"")
    result = subprocess.run(["python3", "-c", sftp_tailscale._ATOMIC_UPLOAD_PY, str(target),
                             content_revision(b"original")], input=framed, capture_output=True, check=False)
    assert (result.returncode == 0) == complete
    assert target.read_bytes() == (data if complete else b"original")
    assert target.stat().st_mode & 0o777 == 0o640
    assert list(tmp_path.iterdir()) == [target]


def test_tailscale_upload_rejects_stale_revision(tmp_path):
    target = tmp_path / "config"
    target.write_bytes(b"external edit")
    result = subprocess.run(["python3", "-c", sftp_tailscale._ATOMIC_UPLOAD_PY, str(target),
                             content_revision(b"original")], input=bytes(8), capture_output=True, check=False)
    assert result.returncode != 0
    assert b"__REVISION_CONFLICT__" in result.stderr
    assert target.read_bytes() == b"external edit"
    assert list(tmp_path.iterdir()) == [target]


def test_tailscale_upload_works_without_new_hashlib_api(tmp_path):
    target = tmp_path / "config"
    target.write_bytes(b"original")
    data = b"new bytes"
    framed = len(data).to_bytes(8, "big") + data + bytes(8)
    script = "import hashlib\nif hasattr(hashlib,'file_digest'): del hashlib.file_digest\n"
    script += sftp_tailscale._ATOMIC_UPLOAD_PY
    result = subprocess.run(["python3", "-c", script, str(target), content_revision(b"original")],
                            input=framed, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    assert target.read_bytes() == data
    assert list(tmp_path.iterdir()) == [target]


@pytest.mark.asyncio
async def test_tailscale_adapter_commits_complete_stream(tmp_path, monkeypatch):
    target = tmp_path / "config"
    target.write_bytes(b"original")
    original_open = sftp_tailscale.anyio.open_process
    async def local_process(command, **kwargs):
        return await original_open(shlex.split(command[-1]), **kwargs)
    monkeypatch.setattr(sftp_tailscale.anyio, "open_process", local_process)
    monkeypatch.setattr(sftp_tailscale, "target_for", lambda host: "sandbox")
    async def chunks():
        yield b"complete bytes"
    written = await sftp_tailscale.upload_stream({}, str(target), chunks(),
                                                 expected_revision=content_revision(b"original"))
    assert written == len(b"complete bytes")
    assert target.read_bytes() == b"complete bytes"
    assert list(tmp_path.iterdir()) == [target]


def test_read_save_and_conflict_through_http(tmp_path, monkeypatch):
    target = tmp_path / "config"
    target.write_bytes(b"original")
    target.chmod(0o640)
    for module in (files_read, files_write):
        monkeypatch.setattr(module, "validate_path", lambda *a, **k: target)
    app = FastAPI()
    app.include_router(files_read.router)
    app.include_router(files_write.router)
    app.dependency_overrides[files_write.verify_auth_token] = lambda: "sandbox-user"
    with TestClient(app) as client:
        read = client.get("/api/files/read", params={"path": "config"})
        assert read.status_code == 200
        revision = read.json()["revision"]
        saved = client.post("/api/files/write", json={"path": "config", "content": "my edit",
                                                    "expectedRevision": revision})
        assert saved.status_code == 200
        assert target.read_bytes() == b"my edit"
        target.write_bytes(b"external edit")
        stale = client.post("/api/files/write", json={"path": "config", "content": "next edit",
                                                    "expectedRevision": saved.json()["revision"]})
        assert stale.status_code == 409
    assert target.read_bytes() == b"external edit"
    assert target.stat().st_mode & 0o777 == 0o640


def test_concurrent_local_saves_accept_only_one_revision(tmp_path):
    target = tmp_path / "config"
    target.write_bytes(b"original")
    revision = content_revision(b"original")
    barrier = threading.Barrier(2)
    def save(data):
        barrier.wait()
        try:
            atomic_write(target, data, revision)
        except FileRevisionConflictError:
            return "conflict"
        return "written"
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(save, data) for data in (b"first", b"second")]
        results = [future.result() for future in futures]
    assert sorted(results) == ["conflict", "written"]
    assert target.read_bytes() in (b"first", b"second")


@pytest.mark.asyncio
async def test_concurrent_remote_saves_accept_only_one_revision(tmp_path, monkeypatch):
    target = tmp_path / "config"
    target.write_bytes(b"original")
    sftp = DiskSftp(tmp_path)
    class Connection:
        @asynccontextmanager
        async def start_sftp_client(self):
            yield sftp
    async def connect(*args):
        return Connection()
    monkeypatch.setattr(host_sftp, "_get_or_open", connect)
    first_entered = anyio.Event()
    release_first = anyio.Event()
    results = []
    async def chunks(first):
        if first:
            first_entered.set()
            await release_first.wait()
        yield b"first" if first else b"second"
    async def save(first, *, task_status=anyio.TASK_STATUS_IGNORED):
        task_status.started()
        try:
            await host_sftp.upload_stream({"id": "h"}, {}, "config", chunks(first),
                                         make_parents=False, expected_revision=content_revision(b"original"))
        except FileRevisionConflictError:
            results.append("conflict")
        else:
            results.append("written")
    async with anyio.create_task_group() as group:
        group.start_soon(save, True)
        await first_entered.wait()
        await group.start(save, False)
        release_first.set()
    assert sorted(results) == ["conflict", "written"]
    assert target.read_bytes() == b"first"
