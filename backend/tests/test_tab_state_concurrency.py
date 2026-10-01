from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import AsyncMock, patch

import anyio
import pytest
from fastapi.testclient import TestClient

import main
from routes import user_state
from sqlite_storage import SQLiteStorage


def test_concurrent_puts_accept_only_one_version(tmp_path):
    # Given: two clients start from the same real SQLite snapshot.
    store = SQLiteStorage(str(tmp_path / "tabs.db"))
    main.app.dependency_overrides[main.verify_auth_token] = lambda: "testuser"
    rendezvous = Barrier(2)
    original_save = store.save_tab_state_checked

    async def synchronized_save(*args, **kwargs):
        rendezvous.wait(timeout=5)
        return await original_save(*args, **kwargs)

    try:
        with patch.object(user_state, "storage", store), patch.object(
            user_state.local_mux, "live_session_names", AsyncMock(return_value=set()),
        ), patch.object(user_state, "stamp_addresses", AsyncMock()), patch.object(
            user_state, "_notify_tab_state_change",
        ) as notify:
            client = TestClient(main.app)
            try:
                initial = client.put("/api/tab-state", json={"tabs": []}).json()["updatedAt"]
                with patch.object(store, "save_tab_state_checked", synchronized_save):
                    def submit(tab_id):
                        return client.put("/api/tab-state", json={
                            "tabs": [{"id": tab_id, "type": "host", "panes": []}],
                            "activeTabId": tab_id, "ifMatch": initial,
                        })

                    # When: both writes reach persistence after reading that version.
                    with ThreadPoolExecutor(max_workers=2) as workers:
                        responses = list(workers.map(submit, ["host:a", "host:b"]))

                # Then: exactly one wins, and the rejected client sees the winning state.
                assert sorted(response.status_code for response in responses) == [200, 409]
                winner = next(response for response in responses if response.status_code == 200)
                conflict = next(response for response in responses if response.status_code == 409)
                assert conflict.json()["current"]["updatedAt"] == winner.json()["updatedAt"]
                assert notify.call_count == 2
            finally:
                client.close()
    finally:
        main.app.dependency_overrides.clear()
        anyio.run(store.close)


@pytest.mark.anyio
async def test_get_cleanup_does_not_overwrite_a_newer_put(tmp_path, monkeypatch):
    # Given: cleanup pauses after reading the old snapshot.
    store = SQLiteStorage(str(tmp_path / "cleanup.db"))
    original = [{"id": "host:old", "type": "host", "panes": []}]
    newer = [{"id": "host:new", "type": "host", "panes": []}]
    await store.save_tab_state("testuser", original, "host:old", 9)
    monkeypatch.setattr(user_state, "storage", store)
    started = anyio.Event()
    changed = anyio.Event()
    results = []

    async def sanitize(tabs, active_tab_id, username):
        started.set()
        await changed.wait()
        return [], None

    monkeypatch.setattr(user_state, "_sanitize_tab_state", sanitize)

    async def get_state():
        results.append(await user_state.get_tab_state("testuser"))

    try:
        # When: another client saves while GET is checking live sessions.
        async with anyio.create_task_group() as group:
            group.start_soon(get_state)
            await started.wait()
            saved = await store.save_tab_state_checked("testuser", newer, "host:new", 3)
            changed.set()
        # Then: cleanup returns the new snapshot and preserves its address counter.
        assert results == [saved.state]
        assert (await store.get_tab_state("testuser"))["tabs"] == newer
        assert results[0]["nextTabAddressNumber"] == 9
    finally:
        await store.close()
