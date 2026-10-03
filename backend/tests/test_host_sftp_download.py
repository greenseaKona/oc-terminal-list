import io
import zipfile

import pytest

import host_sftp
import sftp_tailscale
from host_manager import HostConnectError

# ---------------------- Tailscale 경로 ----------------------


@pytest.mark.asyncio
async def test_tailscale_download_marks_directory_as_zip(monkeypatch):
    async def fake_run_ts(target, cmd, timeout=15.0):
        return b"PK\x03\x04zip-bytes", b"__ITERM_TYPE__dir\n"

    monkeypatch.setattr(sftp_tailscale, "target_for", lambda host: "ubuntu@example")
    monkeypatch.setattr(sftp_tailscale, "run", fake_run_ts)

    data, filename, media_type = await host_sftp.download_item(
        {"id": "h1", "auth_method": "tailscale", "hostname": "example"},
        {},
        "/tmp/bundle",
    )

    assert data == b"PK\x03\x04zip-bytes"
    assert filename == "bundle.zip"
    assert media_type == "application/zip"


@pytest.mark.asyncio
async def test_tailscale_download_keeps_file_name(monkeypatch):
    async def fake_run_ts(target, cmd, timeout=15.0):
        return b"PK-not-a-folder", b"__ITERM_TYPE__file\n"

    monkeypatch.setattr(sftp_tailscale, "target_for", lambda host: "ubuntu@example")
    monkeypatch.setattr(sftp_tailscale, "run", fake_run_ts)

    data, filename, media_type = await host_sftp.download_item(
        {"id": "h1", "auth_method": "tailscale", "hostname": "example"},
        {},
        "/tmp/archive",
    )

    assert data == b"PK-not-a-folder"
    assert filename == "archive"
    assert media_type == "application/octet-stream"


@pytest.mark.asyncio
async def test_tailscale_download_too_large_raises(monkeypatch):
    async def fake_run_ts(target, cmd, timeout=15.0):
        return b"", b"__TOO_LARGE__\n"

    monkeypatch.setattr(sftp_tailscale, "target_for", lambda host: "ubuntu@example")
    monkeypatch.setattr(sftp_tailscale, "run", fake_run_ts)

    with pytest.raises(HostConnectError) as exc:
        await host_sftp.download_item(
            {"id": "h1", "auth_method": "tailscale", "hostname": "example"},
            {},
            "/tmp/huge",
        )
    assert "too large" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_download_item_rejects_empty_path():
    with pytest.raises(HostConnectError):
        await host_sftp.download_item({"id": "h1", "auth_method": "key"}, {}, "")


# ---------------------- SFTP 경로 (asyncssh mock) ----------------------


class _FakeAttrs:
    def __init__(self, *, is_dir=False, size=0, is_link=False):
        import stat as _stat
        if is_link:
            self.permissions = _stat.S_IFLNK | 0o644
        elif is_dir:
            self.permissions = _stat.S_IFDIR | 0o755
        else:
            self.permissions = _stat.S_IFREG | 0o644
        self.size = size


class _FakeEntry:
    def __init__(self, name, *, is_dir=False, size=0, is_link=False):
        self.filename = name
        self.attrs = _FakeAttrs(is_dir=is_dir, size=size, is_link=is_link)


class _FakeFile:
    """asyncssh 파일 핸들 대역 — **커서와 EOF 를 반드시 흉내내야 한다.**

    다운로드 경로는 `while True: read(CHUNK) ... if not data: break` 로 스트리밍한다.
    인자를 무시하고 매번 전체 데이터를 돌려주면 EOF 가 영원히 오지 않아 호출부가
    무한히 누적한다 — 테스트가 박스를 OOM 으로 죽인다(2026-08 실제 사고).
    """

    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def read(self, n=None):
        start = self._pos
        end = len(self._data) if n is None else min(len(self._data), start + n)
        self._pos = end
        return self._data[start:end]


class _FakeSftp:
    """Minimal asyncssh.SFTPClient stand-in for download_item paths."""

    def __init__(self, tree: dict):
        # tree: { "/abs/path": (FakeAttrs, optional entries list, optional bytes) }
        self._tree = tree

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def stat(self, path):
        node = self._tree.get(path)
        if node is None:
            import asyncssh
            raise asyncssh.SFTPError(2, "no such file")
        return node[0]

    async def readdir(self, path):
        return self._tree[path][1]

    def open(self, path, _mode):
        return _FakeFile(self._tree[path][2])


class _FakeConn:
    def __init__(self, sftp):
        self._sftp = sftp

    def start_sftp_client(self):
        return self._sftp


@pytest.mark.asyncio
async def test_sftp_download_single_file(monkeypatch):
    sftp = _FakeSftp({
        "/home/user/notes.txt": (_FakeAttrs(size=11), None, b"hello world"),
    })

    async def fake_open(host, secrets):
        return _FakeConn(sftp)

    monkeypatch.setattr(host_sftp, "_get_or_open", fake_open)
    data, filename, media_type = await host_sftp.download_item(
        {"id": "h1", "auth_method": "key"}, {}, "/home/user/notes.txt"
    )
    assert data == b"hello world"
    assert filename == "notes.txt"
    assert media_type == "application/octet-stream"


@pytest.mark.asyncio
async def test_sftp_stream_allows_single_file_over_200_mib(monkeypatch):
    sftp = _FakeSftp({
        "/archive.tar.gz": (_FakeAttrs(size=host_sftp.MAX_DOWNLOAD_BYTES + 1), None, b"archive chunk"),
    })
    async def fake_open(host, secrets):
        return _FakeConn(sftp)
    monkeypatch.setattr(host_sftp, "_get_or_open", fake_open)
    filename, media_type, stream = await host_sftp.open_download(
        {"id": "h1", "auth_method": "key"}, {}, ["/archive.tar.gz"])
    assert filename == "archive.tar.gz"
    assert media_type == "application/octet-stream"
    assert b"".join([chunk async for chunk in stream]) == b"archive chunk"


@pytest.mark.asyncio
async def test_tailscale_stream_allows_large_single_file_without_buffering(monkeypatch):
    async def info(host, path):
        return False, host_sftp.MAX_DOWNLOAD_BYTES + 1
    async def stream(host, path):
        yield b"archive chunk"
    async def buffered(*args):
        pytest.fail("single files must not use the buffered ZIP transport")
    monkeypatch.setattr(sftp_tailscale, "file_info", info)
    monkeypatch.setattr(sftp_tailscale, "download_stream", stream)
    monkeypatch.setattr(sftp_tailscale, "download_items", buffered)
    filename, media_type, body = await host_sftp.open_download(
        {"id": "h1", "auth_method": "tailscale"}, {}, ["/archive.tar.gz"])
    assert filename == "archive.tar.gz"
    assert media_type == "application/octet-stream"
    assert b"".join([chunk async for chunk in body]) == b"archive chunk"


@pytest.mark.asyncio
@pytest.mark.parametrize("error,status", [(FileNotFoundError(), 404), (PermissionError(), 403)])
async def test_remote_download_head_reports_file_errors(monkeypatch, error, status):
    from fastapi import HTTPException

    from routes import host_files
    async def resolve(*args):
        return {"id": "h1"}, {}
    async def info(*args):
        raise error
    monkeypatch.setattr(host_files, "resolve_host_with_secrets", resolve)
    monkeypatch.setattr(host_sftp, "download_info", info)
    with pytest.raises(HTTPException) as caught:
        await host_files.head_host_file_download("h1", "/missing", "u")
    assert caught.value.status_code == status


@pytest.mark.asyncio
async def test_remote_download_head_returns_size_without_streaming(monkeypatch):
    from routes import host_files
    async def resolve(*args):
        return {"id": "h1"}, {}
    async def info(*args):
        return {"filename": "archive.tar.gz", "size": host_sftp.MAX_DOWNLOAD_BYTES + 1,
                "media_type": "application/octet-stream"}
    monkeypatch.setattr(host_files, "resolve_host_with_secrets", resolve)
    monkeypatch.setattr(host_sftp, "download_info", info)
    response = await host_files.head_host_file_download("h1", "/archive.tar.gz", "u")
    assert response.status_code == 200
    assert response.headers["content-length"] == str(host_sftp.MAX_DOWNLOAD_BYTES + 1)


@pytest.mark.asyncio
async def test_sftp_download_directory_zips_recursively(monkeypatch):
    sftp = _FakeSftp({
        "/work/proj": (_FakeAttrs(is_dir=True), [
            _FakeEntry("a.txt", size=2),
            _FakeEntry("sub", is_dir=True),
            _FakeEntry(".", is_dir=True),  # 무시되어야 함
        ], None),
        "/work/proj/a.txt": (_FakeAttrs(size=2), None, b"AA"),
        "/work/proj/sub": (_FakeAttrs(is_dir=True), [
            _FakeEntry("b.txt", size=3),
        ], None),
        "/work/proj/sub/b.txt": (_FakeAttrs(size=3), None, b"BBB"),
    })

    async def fake_open(host, secrets):
        return _FakeConn(sftp)

    monkeypatch.setattr(host_sftp, "_get_or_open", fake_open)
    data, filename, media_type = await host_sftp.download_item(
        {"id": "h1", "auth_method": "key"}, {}, "/work/proj"
    )
    assert filename == "proj.zip"
    assert media_type == "application/zip"
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = sorted(zf.namelist())
        assert names == ["proj/a.txt", "proj/sub/b.txt"]
        assert zf.read("proj/a.txt") == b"AA"
        assert zf.read("proj/sub/b.txt") == b"BBB"


@pytest.mark.asyncio
async def test_sftp_download_empty_directory_writes_marker(monkeypatch):
    sftp = _FakeSftp({
        "/empty": (_FakeAttrs(is_dir=True), [], None),
    })

    async def fake_open(host, secrets):
        return _FakeConn(sftp)

    monkeypatch.setattr(host_sftp, "_get_or_open", fake_open)
    data, filename, _ = await host_sftp.download_item(
        {"id": "h1", "auth_method": "key"}, {}, "/empty"
    )
    assert filename == "empty.zip"
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        # 빈 디렉터리도 zip 내에 폴더 엔트리로 보존됨.
        assert any(n.endswith("/") for n in zf.namelist())


@pytest.mark.asyncio
async def test_sftp_download_skips_symlinks(monkeypatch):
    sftp = _FakeSftp({
        "/work": (_FakeAttrs(is_dir=True), [
            _FakeEntry("real.txt", size=4),
            _FakeEntry("evil", is_link=True),
        ], None),
        "/work/real.txt": (_FakeAttrs(size=4), None, b"safe"),
    })

    async def fake_open(host, secrets):
        return _FakeConn(sftp)

    monkeypatch.setattr(host_sftp, "_get_or_open", fake_open)
    data, _, _ = await host_sftp.download_item(
        {"id": "h1", "auth_method": "key"}, {}, "/work"
    )
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        assert "work/real.txt" in zf.namelist()
        assert all("evil" not in n for n in zf.namelist())


@pytest.mark.asyncio
async def test_sftp_download_rejects_oversized_file(monkeypatch):
    big = host_sftp.MAX_DOWNLOAD_BYTES + 10
    sftp = _FakeSftp({
        "/big": (_FakeAttrs(size=big), None, b""),
    })

    async def fake_open(host, secrets):
        return _FakeConn(sftp)

    monkeypatch.setattr(host_sftp, "_get_or_open", fake_open)
    with pytest.raises(HostConnectError) as exc:
        await host_sftp.download_item(
            {"id": "h1", "auth_method": "key"}, {}, "/big"
        )
    assert "too large" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_sftp_download_rejects_oversized_directory(monkeypatch):
    """폴더는 **선언된 크기가 아니라 실제로 읽은 바이트**로 막힌다.

    zip 은 흘려보내며 만들기 때문에 총량을 미리 알 수 없다 — `attrs.size` 는 원격이
    주장하는 값일 뿐이라 믿지 않는다. 그래서 크기만 크게 적어둔 빈 파일로는 걸리지
    않는다(그렇게 쓴 예전 버전이 통과하는 것처럼 보였을 뿐이다).

    상한을 낮춰서 검증한다 — 200MB 를 진짜로 만들면 테스트가 박스를 먹는다.
    """
    monkeypatch.setattr(host_sftp, "MAX_DOWNLOAD_BYTES", 8)
    sftp = _FakeSftp({
        "/dir": (_FakeAttrs(is_dir=True), [
            _FakeEntry("a", size=5),
            _FakeEntry("b", size=5),
        ], None),
        "/dir/a": (_FakeAttrs(size=5), None, b"AAAAA"),
        "/dir/b": (_FakeAttrs(size=5), None, b"BBBBB"),
    })

    async def fake_open(host, secrets):
        return _FakeConn(sftp)

    monkeypatch.setattr(host_sftp, "_get_or_open", fake_open)
    with pytest.raises(HostConnectError) as exc:
        await host_sftp.download_item(
            {"id": "h1", "auth_method": "key"}, {}, "/dir"
        )
    assert "too large" in str(exc.value).lower()
