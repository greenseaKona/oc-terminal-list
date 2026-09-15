import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import useWorkspaceTabs from './useWorkspaceTabs';
import { _resetRemoteCwd, getRemoteCwd } from '../utils/remoteCwdStore';

/**
 * 회귀 방지 대상 — 기기 두 대(PC + 폰)를 동시에 열어두면 tab-state 가 서로를 되받아치며
 * 1초 주기로 PUT 이 오가던 에코 루프. 내용이 같으면 아무 요청도 나가면 안 된다.
 */

const tab = (id) => ({
  id, type: 'local', name: id, sessionId: id, panes: [{ id: `${id}-p0`, mode: 'terminal', sessionId: id }],
  layout: 'single', splitTree: { type: 'leaf', paneId: `${id}-p0` }, activePaneId: `${id}-p0`,
});

// 테스트가 직접 메시지를 흘릴 수 있는 EventSource 스텁 (jsdom 엔 없다).
const sseInstances = [];
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.close = vi.fn();
    sseInstances.push(this);
  }
  emit(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

const setupFetch = (initialServerState) => {
  const calls = { getResponses: [], put: [], putResponses: [], state: initialServerState };
  global.fetch = vi.fn(async (url, options = {}) => {
    if (url === '/api/tab-state' && options.method === 'PUT') {
      calls.put.push(JSON.parse(options.body));
      if (calls.putResponses.length > 0) return calls.putResponses.shift();
      return { ok: true, status: 200, json: async () => ({ status: 'saved', updatedAt: `v${calls.put.length}` }) };
    }
    if (url === '/api/tab-state') {
      if (calls.getResponses.length > 0) return calls.getResponses.shift();
      return { ok: true, status: 200, json: async () => calls.state };
    }
    if (url === '/api/sessions') return { ok: true, status: 200, json: async () => [] };
    if (url.startsWith('/api/sse-ticket')) return { ok: true, status: 200, json: async () => ({ ticket: 't' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return calls;
};

describe('useWorkspaceTabs 서버 동기화', () => {
  beforeEach(() => {
    localStorage.clear();
    sseInstances.length = 0;
    _resetRemoteCwd();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    global.EventSource = FakeEventSource;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const flushSave = async () => {
    await act(async () => { vi.advanceTimersByTime(1000); });
  };

  it('서버 상태를 그대로 복원했으면 되받아치는 PUT 을 보내지 않는다', async () => {
    // Arrange — 서버(=다른 기기가 저장한 것)와 로컬 캐시가 같은 내용
    const serverTabs = [tab('a'), tab('b')];
    localStorage.setItem('tabs_v2', JSON.stringify(serverTabs));
    const calls = setupFetch({ tabs: serverTabs, activeTabId: 'a', updatedAt: 'v0' });

    // Act
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    await flushSave();

    // Assert
    expect(calls.put).toHaveLength(0);
    expect(result.current.tabs.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('실제 탭 변경은 한 번만 PUT 하고, 그 뒤 조용하다', async () => {
    const serverTabs = [tab('a')];
    const calls = setupFetch({ tabs: serverTabs, activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    await flushSave();

    act(() => result.current.setTabs((prev) => [...prev, tab('b')]));
    await flushSave();
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0].tabs.map((t) => t.id)).toEqual(['a', 'b']);

    // 같은 내용으로 다시 setTabs (배열 참조만 새로) — 보낼 게 없다
    act(() => result.current.setTabs((prev) => [...prev]));
    await flushSave();
    expect(calls.put).toHaveLength(1);
  });

  it('파괴적 닫기용 즉시 CAS가 충돌하면 로컬 상태를 유지하고 종료를 잠근다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [tab('a'), tab('remote')], updatedAt: 'v1' } }),
    });

    let committed;
    await act(async () => { committed = await result.current.commitWorkspaceTabs([], null); });

    expect(committed).toBe(false);
    expect(calls.put).toHaveLength(1);
    expect(result.current.tabs.map((item) => item.id)).toEqual(['a']);
    expect(result.current.workspaceConflict.current.updatedAt).toBe('v1');
    expect(result.current.canTerminateSessions).toBe(false);
  });

  it('파괴적 닫기용 즉시 CAS가 성공하면 상태를 적용하고 debounce PUT을 만들지 않는다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));

    let committed;
    await act(async () => { committed = await result.current.commitWorkspaceTabs([], null); });
    await flushSave();

    expect(committed).toBe(true);
    expect(calls.put).toHaveLength(1);
    expect(calls.put[0].ifMatch).toBe('v0');
    expect(calls.put[0].tabs).toEqual([]);
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
  });

  it('저장 충돌이 나면 로컬 탭을 덮지 않고 세션 종료를 잠근다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [tab('a'), tab('remote')], updatedAt: 'remote-1' } }),
    });

    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();

    expect(result.current.tabs.map((item) => item.id)).toEqual(['a', 'local']);
    expect(result.current.workspaceConflict).toBeTruthy();
    expect(result.current.canTerminateSessions).toBe(false);
  });

  it('저장 충돌에서 서버 상태를 선택하면 그 스냅샷을 적용한다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [tab('a'), tab('remote')], updatedAt: 'remote-1' } }),
    });
    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();

    await act(async () => result.current.acceptServerWorkspace());

    expect(result.current.tabs.map((item) => item.id)).toEqual(['a', 'remote']);
    expect(result.current.workspaceConflict).toBeNull();
    expect(result.current.canTerminateSessions).toBe(true);
  });

  it('저장 충돌에서 빈 서버 상태를 선택하면 홈으로 이동하고 종료 잠금을 푼다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({
        current: { tabs: [], activeTabId: null, nextTabAddressNumber: 4, updatedAt: 'remote-empty' },
      }),
    });
    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();

    await act(async () => result.current.acceptServerWorkspace());
    await flushSave();

    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
    expect(result.current.workspaceConflict).toBeNull();
    expect(result.current.canTerminateSessions).toBe(true);
    expect(calls.put).toHaveLength(1);
  });

  it('저장 충돌에서 현재 기기를 선택하면 최신 버전으로 한 번 다시 저장한다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [tab('a'), tab('remote')], updatedAt: 'remote-1' } }),
    });
    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();

    act(() => result.current.keepLocalWorkspace());
    await flushSave();

    expect(calls.put).toHaveLength(2);
    expect(calls.put[1].tabs.map((item) => item.id)).toEqual(['a', 'local']);
    expect(calls.put[1].ifMatch).toBe('remote-1');
    expect(result.current.workspaceConflict).toBeNull();
    expect(result.current.canTerminateSessions).toBe(true);
  });

  it('현재 기기 상태는 CAS 재저장이 성공할 때까지 세션 종료 잠금을 유지한다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [tab('a'), tab('remote')], updatedAt: 'remote-1' } }),
    });
    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();
    let resolveRetry;
    calls.putResponses.push(new Promise((resolve) => { resolveRetry = resolve; }));

    act(() => result.current.keepLocalWorkspace());
    await flushSave();

    expect(result.current.workspaceConflict).toBeTruthy();
    expect(result.current.canTerminateSessions).toBe(false);
    await act(async () => {
      resolveRetry({ ok: true, status: 200, json: async () => ({ updatedAt: 'local-2' }) });
      await Promise.resolve();
    });
    expect(result.current.workspaceConflict).toBeNull();
    expect(result.current.canTerminateSessions).toBe(true);
  });

  it('현재 기기 상태 재저장이 다시 충돌하면 새 서버 버전으로 잠금을 유지한다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [tab('a'), tab('remote')], updatedAt: 'remote-1' } }),
    });
    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [tab('a'), tab('newer')], updatedAt: 'remote-2' } }),
    });

    act(() => result.current.keepLocalWorkspace());
    await flushSave();

    expect(result.current.workspaceConflict.current.updatedAt).toBe('remote-2');
    expect(result.current.canTerminateSessions).toBe(false);
  });

  it('서버 high-water mark를 복원해 닫힌 최고 탭 번호를 재사용하지 않는다', async () => {
    const first = { ...tab('a'), addressNumber: 1 };
    const highest = { ...tab('b'), addressNumber: 7 };
    const calls = setupFetch({
      tabs: [first, highest],
      activeTabId: 'a',
      nextTabAddressNumber: 8,
      updatedAt: 'v0',
    });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));

    act(() => result.current.setTabs((prev) => [
      ...prev.filter((item) => item.id !== 'b'),
      tab('c'),
    ]));
    await flushSave();

    expect(result.current.tabs.map((item) => item.addressNumber)).toEqual([1, 8]);
    expect(calls.put[0].nextTabAddressNumber).toBe(9);
  });

  it('오래 열린 닫기 확인도 최신 high-water mark를 되돌리지 않는다', async () => {
    const first = { ...tab('a'), addressNumber: 1 };
    const calls = setupFetch({
      tabs: [first], activeTabId: 'a', nextTabAddressNumber: 2, updatedAt: 'v0',
    });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    const commitFromOpenConfirmation = result.current.commitWorkspaceTabs;

    act(() => result.current.setTabs((prev) => [...prev, tab('b')]));
    await waitFor(() => expect(result.current.tabs.at(-1).addressNumber).toBe(2));
    act(() => result.current.setTabs((prev) => prev.filter((item) => item.id !== 'b')));
    calls.putResponses.push({
      ok: true,
      status: 200,
      json: async () => ({ updatedAt: 'v1', nextTabAddressNumber: 3 }),
    });

    await act(async () => commitFromOpenConfirmation([first], 'a'));
    act(() => result.current.setTabs((prev) => [...prev, tab('c')]));

    expect(result.current.tabs.at(-1).addressNumber).toBe(3);
  });

  it('복원 시 이 기기가 보던 탭을 유지한다 (다른 기기 활성 탭에 끌려가지 않음)', async () => {
    localStorage.setItem('active_tab_id', 'b');
    setupFetch({ tabs: [tab('a'), tab('b')], activeTabId: 'a', updatedAt: 'v0' });

    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));

    expect(result.current.activeTabId).toBe('b');
  });

  it('이 기기가 보던 탭이 서버 상태에 없으면 서버 활성 탭을 채택한다', async () => {
    localStorage.setItem('active_tab_id', 'gone');
    setupFetch({ tabs: [tab('a'), tab('b')], activeTabId: 'b', updatedAt: 'v0' });

    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));

    expect(result.current.activeTabId).toBe('b');
  });

  it('다른 기기의 SSE 변경을 받아 적용해도 되받아치는 PUT 을 보내지 않는다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    await flushSave();
    await waitFor(() => expect(sseInstances).toHaveLength(1));

    // 다른 기기가 탭을 하나 추가함
    calls.state = { tabs: [tab('a'), tab('b')], activeTabId: 'b', updatedAt: 'remote-1' };
    await act(async () => { sseInstances[0].emit({ updatedAt: 'remote-1' }); });
    await flushSave();

    expect(result.current.tabs.map((t) => t.id)).toEqual(['a', 'b']);   // 적용은 됐고
    expect(calls.put).toHaveLength(0);                                   // 되받아치진 않는다

    // 같은 내용을 다시 push (서버가 무의미하게 버전만 올린 경우) — 역시 조용해야 한다
    calls.state = { ...calls.state, updatedAt: 'remote-2' };
    await act(async () => { sseInstances[0].emit({ updatedAt: 'remote-2' }); });
    await flushSave();
    expect(calls.put).toHaveLength(0);
  });

  it('진행 중이던 SSE 조회보다 저장 충돌이 늦게 확정돼도 로컬 탭을 유지한다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    await waitFor(() => expect(sseInstances).toHaveLength(1));
    let resolveSseFetch;
    calls.getResponses.push(new Promise((resolve) => { resolveSseFetch = resolve; }));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [tab('a'), tab('server')], updatedAt: 'server-2' } }),
    });

    act(() => sseInstances[0].emit({ updatedAt: 'server-1' }));
    await act(async () => Promise.resolve());
    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();
    await act(async () => {
      resolveSseFetch({
        ok: true,
        status: 200,
        json: async () => ({ tabs: [tab('a'), tab('stale')], updatedAt: 'server-1' }),
      });
      await Promise.resolve();
    });

    expect(result.current.tabs.map((item) => item.id)).toEqual(['a', 'local']);
    expect(result.current.workspaceConflict).toBeTruthy();
    expect(result.current.canTerminateSessions).toBe(false);
  });

  it('로컬 PUT 성공 전에 시작한 SSE 응답은 성공 뒤에도 적용하지 않는다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    await waitFor(() => expect(sseInstances).toHaveLength(1));
    let resolveSseFetch;
    calls.getResponses.push(new Promise((resolve) => { resolveSseFetch = resolve; }));
    act(() => sseInstances[0].emit({ updatedAt: 'server-stale' }));
    await act(async () => Promise.resolve());

    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();
    await act(async () => {
      resolveSseFetch({
        ok: true,
        status: 200,
        json: async () => ({ tabs: [tab('a'), tab('stale')], updatedAt: 'server-stale' }),
      });
      await Promise.resolve();
    });

    expect(result.current.tabs.map((item) => item.id)).toEqual(['a', 'local']);
  });

  it('충돌 전에 시작한 SSE 응답은 빈 서버 상태를 선택한 뒤 적용하지 않는다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    await waitFor(() => expect(sseInstances).toHaveLength(1));
    let resolveSseFetch;
    calls.getResponses.push(new Promise((resolve) => { resolveSseFetch = resolve; }));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [], activeTabId: null, updatedAt: 'remote-empty' } }),
    });
    act(() => sseInstances[0].emit({ updatedAt: 'server-stale' }));
    await act(async () => Promise.resolve());
    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();

    await act(async () => result.current.acceptServerWorkspace());
    await act(async () => {
      resolveSseFetch({
        ok: true,
        status: 200,
        json: async () => ({ tabs: [tab('a'), tab('stale')], updatedAt: 'server-stale' }),
      });
      await Promise.resolve();
    });

    expect(result.current.tabs).toEqual([]);
  });

  it('충돌 전에 시작한 SSE 응답은 현재 기기 상태 재저장 성공 뒤 적용하지 않는다', async () => {
    const calls = setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    await waitFor(() => expect(sseInstances).toHaveLength(1));
    let resolveSseFetch;
    calls.getResponses.push(new Promise((resolve) => { resolveSseFetch = resolve; }));
    calls.putResponses.push({
      ok: false,
      status: 409,
      json: async () => ({ current: { tabs: [tab('a'), tab('remote')], updatedAt: 'remote-1' } }),
    });
    act(() => sseInstances[0].emit({ updatedAt: 'server-stale' }));
    await act(async () => Promise.resolve());
    act(() => result.current.setTabs((prev) => [...prev, tab('local')]));
    await flushSave();

    act(() => result.current.keepLocalWorkspace());
    await flushSave();
    await act(async () => {
      resolveSseFetch({
        ok: true,
        status: 200,
        json: async () => ({ tabs: [tab('a'), tab('stale')], updatedAt: 'server-stale' }),
      });
      await Promise.resolve();
    });

    expect(result.current.tabs.map((item) => item.id)).toEqual(['a', 'local']);
    expect(result.current.canTerminateSessions).toBe(true);
  });

  it('같은 SSE 연결의 원격 cwd 변경분을 전용 스토어에 적용한다', async () => {
    setupFetch({ tabs: [tab('a')], activeTabId: 'a', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    await waitFor(() => expect(sseInstances).toHaveLength(1));

    act(() => sseInstances[0].emit({
      type: 'remoteCwd', hostId: 'h1', cwds: { mobile: '/srv/app' },
    }));

    expect(getRemoteCwd('h1', 'mobile')).toBe('/srv/app');
  });

  it('보던 탭이 사라지면 첫 탭이 아니라 그 자리 이웃으로 간다', async () => {
    setupFetch({ tabs: [tab('a'), tab('b'), tab('c')], activeTabId: 'c', updatedAt: 'v0' });
    const { result } = renderHook(() => useWorkspaceTabs({ isAuthenticated: true }));
    await waitFor(() => expect(result.current.isRestoringWorkspace).toBe(false));
    act(() => result.current.setActiveTabId('c'));
    expect(result.current.activeTabId).toBe('c');

    // 다른 기기가 마지막 탭을 닫음
    act(() => result.current.setTabs([tab('a'), tab('b')]));

    expect(result.current.activeTabId).toBe('b');
  });
});
