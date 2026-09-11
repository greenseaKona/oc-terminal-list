from unittest.mock import AsyncMock, patch

import pytest

import host_manager


@pytest.mark.anyio
async def test_open_connection_uses_asyncssh_known_hosts_by_default():
    host = {
        "hostname": "server.example",
        "port": 22,
        "ssh_user": "operator",
        "auth_method": "key",
    }
    connection = object()

    with (
        patch.object(host_manager.asyncssh, "import_private_key", return_value="parsed-key"),
        patch.object(host_manager.asyncssh, "connect", AsyncMock(return_value=connection)) as connect,
    ):
        result = await host_manager.open_connection(host, private_key="private-key")

    assert result is connection
    assert "known_hosts" not in connect.await_args_list[0].kwargs


def test_default_network_bindings_keep_first_run_setup_on_loopback():
    root = __import__("pathlib").Path(__file__).resolve().parents[2]

    compose = (root / "compose.yml").read_text(encoding="utf-8")
    env_example = (root / ".env.example").read_text(encoding="utf-8")

    assert '127.0.0.1:${APP_PORT:-38822}:${APP_PORT:-38822}' in compose
    assert "HOST=127.0.0.1" in env_example
