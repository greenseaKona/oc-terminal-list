import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useActiveTerminalCwd from './useActiveTerminalCwd';
import { _resetRemoteCwd, applyRemoteCwdChanges } from '../utils/remoteCwdStore';

/* Local cwd goes through the shared batcher (utils/hostCwdBatch), so the mocked
   response is the batch shape and every assertion has to advance past the batch
   window — a lookup is never synchronous any more. */
const BATCH_WINDOW_MS = 60;

const batchOf = (map) => ({ ok: true, json: async () => ({ cwds: map }) });

describe('useActiveTerminalCwd', () => {
  beforeEach(() => { vi.useFakeTimers(); _resetRemoteCwd(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('cwd 를 끝내 못 받아도 재시도 사다리는 끝이 있다', async () => {
    // 예전엔 30s 캡에서 영원히 돌았다 — pane 하나가 분당 2회(원격이면 SSH 왕복)를 영구히 태웠다.
    global.fetch = vi.fn(async () => batchOf({}));
    const { result } = renderHook(() => useActiveTerminalCwd({ sessionId: 's1', isLocal: true }));

    // Unknown before the first response is not the confirmed workspace root ('').
    expect(result.current.workspaceRelative).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });

    // 최초 1회 + MAX_CWD_RETRIES(5)
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });

  it('cwd 를 받으면 그 자리에서 멈춘다', async () => {
    global.fetch = vi.fn(async () => batchOf({ s1: { cwd: '/home/me', in_workspace: false } }));
    const { result } = renderHook(() => useActiveTerminalCwd({ sessionId: 's1', isLocal: true }));

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.current.absolutePath).toBe('/home/me');
  });

  it('같은 순간에 뜬 pane 들은 요청 하나를 나눠 쓴다', async () => {
    global.fetch = vi.fn(async () => batchOf({
      s1: { cwd: '/a', in_workspace: false },
      s2: { cwd: '/b', in_workspace: false },
    }));
    const a = renderHook(() => useActiveTerminalCwd({ sessionId: 's1', isLocal: true }));
    const b = renderHook(() => useActiveTerminalCwd({ sessionId: 's2', isLocal: true }));

    await act(async () => { await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS); });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(a.result.current.absolutePath).toBe('/a');
    expect(b.result.current.absolutePath).toBe('/b');
  });

  it('refreshSignal 이 바뀌면(=세션이 붙으면) 사다리를 새로 시작한다', async () => {
    global.fetch = vi.fn(async () => batchOf({}));
    const { rerender } = renderHook(
      ({ sig }) => useActiveTerminalCwd({ sessionId: 's1', isLocal: true, refreshSignal: sig }),
      { initialProps: { sig: '0:0' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(global.fetch).toHaveBeenCalledTimes(6);

    global.fetch.mockClear();
    rerender({ sig: '0:1' });
    await act(async () => { await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('deferMs 가 있으면 첫 조회를 미룬다', async () => {
    global.fetch = vi.fn(async () => batchOf({ s1: { cwd: '/x', in_workspace: false } }));
    renderHook(() => useActiveTerminalCwd({ sessionId: 's1', isLocal: true, deferMs: 2000 }));

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(global.fetch).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1000 + BATCH_WINDOW_MS); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('deferMs 만 바뀌는 것으로는 다시 조회하지 않는다 — 탭을 떠나는 쪽은 공짜여야 한다', async () => {
    global.fetch = vi.fn(async () => batchOf({ s1: { cwd: '/x', in_workspace: false } }));
    const { rerender } = renderHook(
      ({ d }) => useActiveTerminalCwd({ sessionId: 's1', isLocal: true, deferMs: d }),
      { initialProps: { d: 0 } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS); });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    rerender({ d: 1500 });   // pane 이 안 보이게 됨
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('다시 보이게 되면(refreshSignal) 미루지 않고 바로 조회한다', async () => {
    global.fetch = vi.fn(async () => batchOf({ s1: { cwd: '/x', in_workspace: false } }));
    const { rerender } = renderHook(
      ({ d, sig }) => useActiveTerminalCwd({ sessionId: 's1', isLocal: true, deferMs: d, refreshSignal: sig }),
      { initialProps: { d: 1500, sig: 'v0' } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(1500 + BATCH_WINDOW_MS); });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    rerender({ d: 0, sig: 'v1' });   // 다시 보임
    await act(async () => { await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS); });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('원격 tmux cwd SSE는 추가 fetch 없이 즉시 적용한다', async () => {
    global.fetch = vi.fn(async () => batchOf({ mobile: '/srv/old' }));
    const { result } = renderHook(() => useActiveTerminalCwd({
      hostId: 'h1', tmuxSession: 'mobile', isLocal: false,
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS); });
    expect(result.current.absolutePath).toBe('/srv/old');

    act(() => applyRemoteCwdChanges('h1', { mobile: '/srv/new' }));

    expect(result.current.absolutePath).toBe('/srv/new');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('요청 중 도착한 SSE cwd를 늦은 응답으로 되돌리지 않는다', async () => {
    let finishFetch;
    global.fetch = vi.fn(() => new Promise((resolve) => {
      finishFetch = () => resolve(batchOf({ mobile: '/srv/old' }));
    }));
    const { result } = renderHook(() => useActiveTerminalCwd({
      hostId: 'h1', tmuxSession: 'mobile', isLocal: false,
    }));

    act(() => { vi.advanceTimersByTime(BATCH_WINDOW_MS); });
    act(() => applyRemoteCwdChanges('h1', { mobile: '/srv/new' }));
    await act(async () => { finishFetch(); await Promise.resolve(); });

    expect(result.current.absolutePath).toBe('/srv/new');
  });

  it('pane identity가 바뀌면 즉시 초기화하고 이전 요청 결과를 버린다', async () => {
    let finishOldFetch;
    global.fetch = vi.fn((url) => {
      if (String(url).includes('ids=old')) {
        return new Promise((resolve) => {
          finishOldFetch = () => resolve(batchOf({ old: { cwd: '/old', in_workspace: false } }));
        });
      }
      return Promise.resolve(batchOf({ next: { cwd: '/next', in_workspace: false } }));
    });
    const { result, rerender } = renderHook(
      ({ sessionId }) => useActiveTerminalCwd({ sessionId, isLocal: true }),
      { initialProps: { sessionId: 'old' } },
    );

    act(() => { vi.advanceTimersByTime(BATCH_WINDOW_MS); });
    rerender({ sessionId: 'next' });
    expect(result.current.absolutePath).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(BATCH_WINDOW_MS); });
    expect(result.current.absolutePath).toBe('/next');

    await act(async () => { finishOldFetch(); await Promise.resolve(); });
    expect(result.current.absolutePath).toBe('/next');
  });
});
