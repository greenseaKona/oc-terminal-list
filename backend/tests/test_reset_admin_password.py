from __future__ import annotations

import os
import pty
import select
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import bcrypt
import pytest

import reset_admin_password
from auth_manager import _verify_secret


@pytest.fixture
def recovery_db(tmp_path: Path) -> Path:
    path = tmp_path / "auth.db"
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.executescript(
            "CREATE TABLE admin (username TEXT PRIMARY KEY, password TEXT, auth_version INTEGER, otp_enabled INTEGER);"
            "CREATE TABLE auth_sessions (session_id TEXT, username TEXT);"
            "CREATE TABLE passkey_credentials (credential_id TEXT, username TEXT);"
            "INSERT INTO admin VALUES ('admin', 'old-hash', 7, 1);"
            "INSERT INTO auth_sessions VALUES ('old-session', 'admin');"
            "INSERT INTO passkey_credentials VALUES ('existing-passkey', 'admin');"
        )
    return path


def test_recovery_accepts_new_password_without_old_password(recovery_db, monkeypatch, capsys):
    # Given an admin with an unknown password, a session, OTP and a passkey.
    monkeypatch.setattr(sys, "argv", ["reset", "--database", str(recovery_db), "--confirm"])
    monkeypatch.setattr(reset_admin_password.getpass, "getpass", lambda _: "replacement-password")
    # When the local recovery command runs.
    assert reset_admin_password.main() == 0
    # Then the new password works and existing sessions are revoked, preserving other credentials.
    with closing(sqlite3.connect(recovery_db)) as conn:
        password, version, otp = conn.execute("SELECT password, auth_version, otp_enabled FROM admin").fetchone()
        assert _verify_secret("replacement-password", password)
        assert version == 8
        assert otp == 1
        assert conn.execute("SELECT count(*) FROM auth_sessions").fetchone()[0] == 0
        assert conn.execute("SELECT credential_id FROM passkey_credentials").fetchone()[0] == "existing-passkey"
    output = capsys.readouterr()
    assert "replacement-password" not in output.out + output.err


@pytest.mark.parametrize("entries", [("short", "short"), ("replacement-password", "different-password")])
def test_invalid_input_preserves_password_and_sessions(recovery_db, monkeypatch, entries):
    # Given an invalid new password or mismatched confirmation.
    monkeypatch.setattr(sys, "argv", ["reset", "--database", str(recovery_db), "--confirm"])
    inputs = iter(entries)
    monkeypatch.setattr(reset_admin_password.getpass, "getpass", lambda _: next(inputs))
    # When recovery is attempted.
    assert reset_admin_password.main() == 1
    # Then neither the password nor active sessions changes.
    with closing(sqlite3.connect(recovery_db)) as conn:
        assert conn.execute("SELECT password, auth_version FROM admin").fetchone() == ("old-hash", 7)
        assert conn.execute("SELECT count(*) FROM auth_sessions").fetchone()[0] == 1


def test_preview_does_not_prompt_or_change_password(recovery_db, monkeypatch):
    # Given a command without explicit confirmation.
    monkeypatch.setattr(sys, "argv", ["reset", "--database", str(recovery_db)])
    monkeypatch.setattr(reset_admin_password.getpass, "getpass", lambda _: pytest.fail("unexpected password prompt"))
    # When the preview runs.
    assert reset_admin_password.main() == 0
    # Then the password is unchanged.
    with closing(sqlite3.connect(recovery_db)) as conn:
        assert conn.execute("SELECT password FROM admin").fetchone()[0] == "old-hash"


def test_missing_database_is_not_created(tmp_path, monkeypatch):
    # Given a nonexistent database path.
    path = tmp_path / "missing.db"
    monkeypatch.setattr(sys, "argv", ["reset", "--database", str(path), "--confirm"])
    # When recovery is attempted.
    assert reset_admin_password.main() == 1
    # Then no empty database is created.
    assert not path.exists()


def test_cli_refuses_password_input_without_hidden_terminal(recovery_db):
    # Given a real CLI process with piped input instead of a terminal.
    command = Path(reset_admin_password.__file__)
    # When the user attempts a password reset through that process.
    result = subprocess.run(
        [sys.executable, str(command), "--database", str(recovery_db), "--confirm"],
        input="replacement-password\nreplacement-password\n",
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    # Then it refuses rather than exposing the password or changing the account.
    assert result.returncode == 1
    assert "replacement-password" not in result.stdout + result.stderr
    with closing(sqlite3.connect(recovery_db)) as conn:
        assert conn.execute("SELECT password, auth_version FROM admin").fetchone() == ("old-hash", 7)


def test_concurrent_password_change_is_not_overwritten(recovery_db, monkeypatch):
    # Given another password change while recovery is waiting for input.
    monkeypatch.setattr(sys, "argv", ["reset", "--database", str(recovery_db), "--confirm"])

    def password_prompt(_: str) -> str:
        with closing(sqlite3.connect(recovery_db)) as conn, conn:
            conn.execute("UPDATE admin SET password = 'concurrent-hash', auth_version = 8")
        return "replacement-password"

    monkeypatch.setattr(reset_admin_password.getpass, "getpass", password_prompt)
    # When the recovery command attempts to store its password.
    assert reset_admin_password.main() == 1
    # Then the concurrent password and existing sessions remain untouched.
    with closing(sqlite3.connect(recovery_db)) as conn:
        assert conn.execute("SELECT password, auth_version FROM admin").fetchone() == ("concurrent-hash", 8)
        assert conn.execute("SELECT count(*) FROM auth_sessions").fetchone()[0] == 1


def read_terminal_until(fd: int, expected: bytes) -> bytes:
    output = bytearray()
    while expected not in output:
        ready, _, _ = select.select([fd], [], [], 10)
        assert ready, "CLI did not reach the expected input/output state"
        data = os.read(fd, 4096)
        assert data, "CLI closed the terminal unexpectedly"
        output.extend(data)
    return bytes(output)


def test_real_terminal_recovery_hides_password_and_updates_account(recovery_db):
    # Given a real terminal and the CLI connected to a temporary database.
    master, slave = pty.openpty()
    command = Path(reset_admin_password.__file__)
    process = subprocess.Popen(
        [sys.executable, str(command), "--database", str(recovery_db), "--confirm"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    try:
        # When a new password is entered twice through the terminal.
        output = read_terminal_until(master, "새 비밀번호 (8자 이상): ".encode())
        os.write(master, b"replacement-password\n")
        output += read_terminal_until(master, "새 비밀번호 확인: ".encode())
        os.write(master, b"replacement-password\n")
        output += read_terminal_until(master, "백엔드를 재시작한 뒤".encode())
        # Then the command succeeds without echoing either password entry.
        assert process.wait(timeout=10) == 0
        assert b"replacement-password" not in output
        with closing(sqlite3.connect(recovery_db)) as conn:
            password = conn.execute("SELECT password FROM admin").fetchone()[0]
            assert _verify_secret("replacement-password", password)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        os.close(master)


def test_legacy_bcrypt_password_verification_accepts_matching_password():
    # Given a legacy bcrypt hash generated by the installed bcrypt library.
    value = "legacy-password-for-verification"
    hashed = bcrypt.hashpw(value.encode(), bcrypt.gensalt(rounds=4)).decode()
    # When the application's actual legacy verifier checks it.
    result = _verify_secret(value, hashed)
    # Then a correct password is accepted.
    assert result is True
