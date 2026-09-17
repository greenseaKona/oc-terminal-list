from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from fastapi import Request

from models import PasskeyRegisterCompleteRequest
from routes import auth as auth_route


@pytest.mark.anyio
async def test_registration_persists_string_aaguid_as_uuid_bytes() -> None:
    # Given
    aaguid = "ea9b8d66-4d01-1d21-3c1f-9a7c7c4b6d21"
    manager = SimpleNamespace(
        _consume_passkey_challenge=lambda kind, key: b"challenge",
    )
    verification = SimpleNamespace(
        credential_id=b"credential-id",
        credential_public_key=b"public-key",
        sign_count=0,
        aaguid=aaguid,
        credential_backed_up=True,
    )
    request = PasskeyRegisterCompleteRequest(
        label="iPhone",
        response={"response": {"transports": ["internal"]}},
    )
    http_request = Request({
        "type": "http",
        "method": "POST",
        "path": "/api/auth/passkey/register/complete",
        "headers": [(b"host", b"terminal.example")],
        "scheme": "https",
        "server": ("terminal.example", 443),
    })
    add_credential = AsyncMock(return_value=7)

    # When
    with (
        patch.object(auth_route, "get_auth_manager", return_value=manager),
        patch.object(auth_route, "_verify_reg", return_value=verification),
        patch.object(auth_route.storage, "add_passkey_credential", add_credential),
    ):
        result = await auth_route.passkey_register_complete(
            request=request,
            http_request=http_request,
            username="admin",
        )

    # Then
    assert result == {"status": "registered", "id": 7, "label": "iPhone"}
    add_credential.assert_awaited_once()
    call = add_credential.await_args
    assert call is not None
    assert call.kwargs["aaguid"] == UUID(aaguid).bytes
