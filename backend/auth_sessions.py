"""Request identity and revocation signals for active browser connections."""
from __future__ import annotations

import time
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass, field
from weakref import WeakSet

import anyio
from fastapi import WebSocket


@dataclass(slots=True)
class BrowserSession:
    """Mutable connection registry; the database remains the authority for JWTs."""

    session_id: str
    username: str
    expires_at: float
    revoked: anyio.Event = field(default_factory=anyio.Event)
    sockets: WeakSet[WebSocket] = field(default_factory=WeakSet)
    stream_stoppers: set[Callable[[], None]] = field(default_factory=set)

    @property
    def active(self) -> bool:
        return not self.revoked.is_set() and self.expires_at > time.time()


current_session: ContextVar[BrowserSession | None] = ContextVar("browser_session", default=None)
verified_credentials: ContextVar[tuple[str, int] | None] = ContextVar("verified_credentials", default=None)
_sessions: dict[str, BrowserSession] = {}


def bind_session(session_id: str, username: str, expires_at: float) -> BrowserSession:
    """Bind a database-verified identity to this request and its child tasks."""
    expired = [key for key, session in _sessions.items()
               if not session.active and not session.sockets and not session.stream_stoppers]
    for key in expired:
        _sessions.pop(key, None)
    session = _sessions.get(session_id)
    if session is None:
        session = BrowserSession(session_id, username, expires_at)
        _sessions[session_id] = session
    session.expires_at = expires_at
    current_session.set(session)
    return session


async def revoke_connections(username: str, session_id: str | None = None) -> None:
    """Stop streams and sockets without terminating their tmux sessions."""
    sessions = [s for s in _sessions.values() if s.username == username
                and (session_id is None or s.session_id == session_id)]
    for session in sessions:
        session.revoked.set()
        for stop_stream in list(session.stream_stoppers):
            stop_stream()
    for session in sessions:
        for websocket in list(session.sockets):
            try:
                with anyio.move_on_after(2):
                    await websocket.close(code=1008, reason="인증 세션이 만료되었습니다")
            except (RuntimeError, OSError):
                # A concurrently disconnected socket has already released access.
                session.sockets.discard(websocket)
