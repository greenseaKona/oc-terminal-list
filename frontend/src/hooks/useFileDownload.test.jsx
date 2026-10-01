import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthFallbacks, setVolatileAuthToken } from '../utils/auth';
import useFileDownload from './useFileDownload';

const useDownloads = () => useFileDownload({ apiBase: '/api/files', t: (key) => key });
const waitForAbort = (signal) => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
});

describe('useFileDownload', () => {
  let click;
  beforeEach(() => {
    vi.useFakeTimers();
    clearAuthFallbacks();
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn());
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearAuthFallbacks();
  });

  it('hands a large single file to the browser without reading it into a blob', async () => {
    // Given: the server accepts a single-file download preflight.
    const blob = vi.fn();
    fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'content-disposition': 'attachment; filename="huge.bin"' }), blob });
    const { result } = renderHook(useDownloads);
    // When: the user downloads that file.
    await act(() => result.current.downloadNode('/huge.bin', 'file'));
    // Then: the native download owns the body and the UI only reports initiation.
    expect(fetch).toHaveBeenCalledWith('/api/files/download?path=%2Fhuge.bin', expect.objectContaining({ method: 'HEAD' }));
    expect(blob).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
    expect(result.current.downloadState.message).toBe('downloadStarted');
  });

  it('ends a stalled response with a retryable timeout instead of staying pending', async () => {
    // Given: the connection never returns response headers.
    fetch.mockImplementation((url, { signal }) => waitForAbort(signal));
    const { result } = renderHook(useDownloads);
    let pending;
    act(() => { pending = result.current.downloadNode('/slow.bin', 'file'); });
    // When: the response deadline expires.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); await pending; });
    // Then: the request is aborted and no download starts.
    expect(result.current.downloadState).toMatchObject({ pending: false, error: true });
    expect(result.current.downloadState.message).toContain('시간이 초과');
    expect(click).not.toHaveBeenCalled();
  });

  it('applies the archive deadline while consuming a stalled response body', async () => {
    // Given: an archive responds with headers but its body stops arriving.
    fetch.mockImplementation((url, { signal }) => Promise.resolve({
      ok: true, headers: new Headers(), blob: () => waitForAbort(signal),
    }));
    const { result } = renderHook(useDownloads);
    let pending;
    act(() => { pending = result.current.downloadZip(['a', 'b']); });
    // When: the body deadline expires.
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); await pending; });
    // Then: the UI reports timeout rather than successful initiation.
    expect(result.current.downloadState).toMatchObject({ pending: false, error: true });
    expect(click).not.toHaveBeenCalled();
  });

  it('keeps a newer download visible after an earlier completion timer expires', async () => {
    // Given: one download has finished and scheduled its status dismissal.
    fetch.mockResolvedValueOnce({ ok: true, headers: new Headers() });
    fetch.mockImplementationOnce((url, { signal }) => waitForAbort(signal));
    const { result } = renderHook(useDownloads);
    await act(() => result.current.downloadNode('/first.bin', 'file'));
    let pending;
    act(() => { pending = result.current.downloadNode('/second.bin', 'file'); });
    // When: the first transfer's dismissal time passes.
    await act(() => vi.advanceTimersByTimeAsync(2000));
    // Then: the second transfer's pending status remains visible.
    expect(result.current.downloadState).toMatchObject({ fileName: 'second.bin', pending: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(28_000); await pending; });
  });

  it('does not start a native download after an authentication or missing-file error', async () => {
    // Given: the server rejects the preflight.
    fetch.mockResolvedValue({ ok: false, status: 404, headers: new Headers() });
    const { result } = renderHook(useDownloads);
    // When: the user requests the missing file.
    await act(() => result.current.downloadNode('/missing.bin', 'file'));
    // Then: the error remains visible and no native request starts.
    expect(result.current.downloadState).toMatchObject({ error: true, message: 'downloadFailed (404)' });
    expect(click).not.toHaveBeenCalled();
  });

  it('cancels an in-flight preflight when the file tree unmounts', async () => {
    // Given: the file tree owns an unfinished request.
    fetch.mockImplementation((url, { signal }) => waitForAbort(signal));
    const { result, unmount } = renderHook(useDownloads);
    let pending;
    act(() => { pending = result.current.downloadNode('/slow.bin', 'file'); });
    const signal = fetch.mock.calls[0][1].signal;
    // When: navigation removes the tree.
    unmount();
    await pending;
    // Then: it aborts the old request and prevents a delayed download click.
    expect(signal.aborted).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

  it('repairs expired cookie authentication before handing the download to the browser', async () => {
    // Given: a fallback token is valid while the native-download cookie has expired.
    setVolatileAuthToken('test-token');
    fetch.mockResolvedValueOnce({ ok: true, headers: new Headers() });
    fetch.mockResolvedValueOnce({ ok: true, headers: new Headers() });
    const { result } = renderHook(useDownloads);
    // When: the user starts a download without refreshing the page.
    await act(() => result.current.downloadNode('/file.bin', 'file'));
    // Then: verification promotes the fallback token before cookie-only HEAD authorizes native GET.
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/auth/verify', expect.objectContaining({
      headers: { Authorization: 'Bearer test-token' },
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/files/download?path=%2Ffile.bin', expect.objectContaining({
      method: 'HEAD', credentials: 'same-origin',
    }));
    expect(click).toHaveBeenCalledOnce();
    expect(result.current.downloadState.error).toBe(false);
  });
});
