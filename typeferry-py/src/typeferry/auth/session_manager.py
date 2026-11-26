"""In-memory session manager — port of
``typeferry-ts/src/auth/server/session-manager.ts``.

Handles refresh-token rotation, grace-period tolerance for concurrent
refresh calls, and family-level revocation on detected theft.

For multi-instance deployments, implement the :class:`SessionManager`
protocol over a shared backend (Redis, Postgres, etc.).
"""

from __future__ import annotations

import asyncio
import time
import uuid as _uuid
from typing import Protocol, runtime_checkable

from typeferry.auth.jwt_utils import sign_access_token
from typeferry.auth.types import (
    AccessTokenPayload,
    AuthConfig,
    DeviceInfo,
    Session,
    TokenPair,
)


@runtime_checkable
class SessionManager(Protocol):
    async def create_session(
        self, user_id: str, device_info: DeviceInfo | None = None
    ) -> TokenPair: ...

    async def refresh_session(
        self, refresh_token: str, device_info: DeviceInfo | None = None
    ) -> TokenPair | None: ...

    async def revoke_session(self, session_id: str) -> bool: ...

    async def revoke_family(self, family_id: str) -> int: ...

    async def get_user_sessions(self, user_id: str) -> list[Session]: ...

    async def revoke_all_user_sessions(
        self, user_id: str, except_family_id: str | None = None
    ) -> int: ...


class InMemorySessionManager:
    """Reference implementation for single-instance deployments and tests."""

    def __init__(self, config: AuthConfig) -> None:
        self.config = config
        self._sessions: dict[str, Session] = {}
        self._cleanup_task: asyncio.Task[None] | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def create_session(
        self, user_id: str, device_info: DeviceInfo | None = None
    ) -> TokenPair:
        if len(self._sessions) >= 10_000:
            self._cleanup()
        family_id = _fresh_id()
        token = _fresh_id()
        session_id = _fresh_id()

        expiration = _now_seconds() + self.config.refresh_token_expiry_days * 86400

        session = Session(
            id=session_id,
            user_id=user_id,
            family_id=family_id,
            token=token,
            expiration=expiration,
            device_info=device_info,
        )
        self._sessions[token] = session
        return self._build_token_pair(token, user_id, session_id)

    async def refresh_session(
        self, refresh_token: str, device_info: DeviceInfo | None = None
    ) -> TokenPair | None:
        session = self._sessions.get(refresh_token)
        if session is None or session.is_revoked:
            return None
        if _now_seconds() > session.expiration:
            return None
        if session.replaced_by is not None:
            return self._handle_reused_token(session)
        return await self._rotate_session(session, device_info)

    async def revoke_session(self, session_id: str) -> bool:
        for session in self._sessions.values():
            if session.id == session_id:
                session.is_revoked = True
                return True
        return False

    async def revoke_family(self, family_id: str) -> int:
        count = 0
        for session in self._sessions.values():
            if session.family_id == family_id and not session.is_revoked:
                session.is_revoked = True
                count += 1
        return count

    async def get_user_sessions(self, user_id: str) -> list[Session]:
        now = _now_seconds()
        return [
            s
            for s in self._sessions.values()
            if s.user_id == user_id
            and not s.is_revoked
            and s.replaced_by is None
            and s.expiration > now
        ]

    async def revoke_all_user_sessions(
        self, user_id: str, except_family_id: str | None = None
    ) -> int:
        count = 0
        for session in self._sessions.values():
            if (
                session.user_id == user_id
                and not session.is_revoked
                and (except_family_id is None or session.family_id != except_family_id)
            ):
                session.is_revoked = True
                count += 1
        return count

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start_cleanup(self, interval_seconds: int = 60) -> None:
        """Start a periodic cleanup task. Safe to call without a running loop."""

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._cleanup_task = loop.create_task(self._cleanup_loop(interval_seconds))

    async def _cleanup_loop(self, interval_seconds: int) -> None:
        try:
            while True:
                await asyncio.sleep(interval_seconds)
                self._cleanup()
        except asyncio.CancelledError:
            pass

    def _cleanup(self) -> None:
        now = _now_seconds()
        for key in list(self._sessions.keys()):
            session = self._sessions[key]
            if session.is_revoked or session.expiration <= now:
                self._sessions.pop(key, None)

    def destroy(self) -> None:
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            self._cleanup_task = None
        self._sessions.clear()

    @property
    def size(self) -> int:
        return len(self._sessions)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _rotate_session(
        self, session: Session, device_info: DeviceInfo | None
    ) -> TokenPair:
        new_token = _fresh_id()
        new_session_id = _fresh_id()
        expiration = _now_seconds() + self.config.refresh_token_expiry_days * 86400

        new_session = Session(
            id=new_session_id,
            user_id=session.user_id,
            family_id=session.family_id,
            token=new_token,
            expiration=expiration,
            device_info=device_info,
        )

        session.replaced_by = new_token
        session.used_at = time.monotonic() * 1000
        self._sessions[new_token] = new_session
        return self._build_token_pair(new_token, session.user_id, new_session_id)

    def _handle_reused_token(self, session: Session) -> TokenPair | None:
        grace_ms = self.config.rotation_grace_period_seconds * 1000
        now_ms = time.monotonic() * 1000

        if session.used_at is None or (now_ms - session.used_at) > grace_ms:
            # Out of grace → theft. Revoke the family.
            for s in self._sessions.values():
                if s.family_id == session.family_id and not s.is_revoked:
                    s.is_revoked = True
            return None

        if session.replaced_by is None:
            return None
        next_session = self._sessions.get(session.replaced_by)
        if (
            next_session is None
            or next_session.is_revoked
            or next_session.replaced_by is not None
            or _now_seconds() > next_session.expiration
        ):
            return None
        return self._build_token_pair(
            next_session.token, next_session.user_id, next_session.id
        )

    def _build_token_pair(
        self, refresh_token: str, user_id: str, session_id: str
    ) -> TokenPair:
        iat = _now_seconds()
        exp = iat + self.config.access_token_expiry_minutes * 60
        payload = AccessTokenPayload(
            user_id=user_id, session_id=session_id, iat=iat, exp=exp
        )
        access_token = sign_access_token(payload, self.config)
        return TokenPair(access_token=access_token, refresh_token=refresh_token, exp=exp)


def _now_seconds() -> int:
    return int(time.time())


def _fresh_id() -> str:
    return str(_uuid.uuid4())
