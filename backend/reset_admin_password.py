#!/usr/bin/env python3
"""Recover the local administrator password using server filesystem access.

Run with --confirm to enter a new password without knowing the old one.
Restart the backend afterwards to close existing authenticated connections.
"""
from __future__ import annotations

import argparse
import getpass
import os
import sqlite3
import sys
import warnings
from contextlib import closing
from pathlib import Path

from dotenv import load_dotenv

from auth_manager import _hash_secret


class RecoveryArgs(argparse.Namespace):
    database: Path
    confirm: bool


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    load_dotenv(root / ".env")
    parser = argparse.ArgumentParser(description="기존 비밀번호 없이 관리자 비밀번호 재설정")
    parser.add_argument("--database", type=Path, default=Path(os.getenv("DB_PATH") or root / "data/iterminallist.db"))
    parser.add_argument("--confirm", action="store_true", help="새 비밀번호를 입력하고 실제 변경")
    args = parser.parse_args(namespace=RecoveryArgs())
    try:
        # mode=rw refuses to create a database if the path is wrong.
        with closing(sqlite3.connect(f"{args.database.resolve().as_uri()}?mode=rw", uri=True)) as conn:
            row = conn.execute("SELECT username, password, auth_version FROM admin LIMIT 1").fetchone()
            if row is None:
                print("관리자 계정이 없습니다.", file=sys.stderr)
                return 1
            username, old_hash, version = row
            print(f"재설정 대상: {username}")
            if not args.confirm:
                print("미리보기입니다. --confirm을 붙이면 새 비밀번호를 숨김 입력으로 받습니다.")
                return 0
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                password = getpass.getpass("새 비밀번호 (8자 이상): ")
                repeated = getpass.getpass("새 비밀번호 확인: ")
            if len(password) < 8 or password != repeated:
                print("비밀번호는 8자 이상이어야 하며 두 입력이 같아야 합니다. 변경하지 않았습니다.", file=sys.stderr)
                return 1
            new_hash = _hash_secret(password)
            with conn:
                updated = conn.execute(
                    "UPDATE admin SET password = ?, auth_version = auth_version + 1 "
                    "WHERE username = ? AND password = ? AND auth_version = ?",
                    (new_hash, username, old_hash, version),
                )
                if updated.rowcount != 1:
                    print("입력 중 계정 정보가 변경되었습니다. 다시 실행해주세요.", file=sys.stderr)
                    return 1
                conn.execute("DELETE FROM auth_sessions WHERE username = ?", (username,))
            print("비밀번호를 재설정했습니다. 기존 로그인 세션은 무효화되고 패스키와 2단계 인증은 유지됩니다.")
            print("백엔드를 재시작한 뒤 새 비밀번호 또는 패스키로 다시 로그인해주세요.")
            return 0
    except getpass.GetPassWarning:
        print("비밀번호를 숨길 수 있는 대화형 터미널에서 실행해주세요. 변경하지 않았습니다.", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\n입력을 취소했습니다. 변경하지 않았습니다.", file=sys.stderr)
        return 130
    except sqlite3.Error as exc:
        print(f"데이터베이스 작업 실패: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
