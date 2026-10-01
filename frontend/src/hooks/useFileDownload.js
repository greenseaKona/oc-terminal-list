/** Authenticated downloads with browser-owned single-item transfers. */
import { useEffect, useRef, useState } from 'react';
import { authHeaders } from '../utils/auth';

const REQUEST_TIMEOUT_MS = 30_000;
const ZIP_TIMEOUT_MS = 300_000;
const basename = (path) => path.split('/').filter(Boolean).pop() || 'download';
const checkAborted = (signal) => {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
};

const filenameFromDisposition = (header, defaultName) => {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header || '');
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { /* Fall back to the plain filename. */ }
  }
  return /filename="?([^";]+)"?/i.exec(header || '')?.[1] || defaultName;
};

const triggerDownload = (url, filename) => {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

export default function useFileDownload({ apiBase, t }) {
  const [downloadState, setDownloadState] = useState(null);
  const sequence = useRef(0);
  const resetTimer = useRef(null);
  const controllers = useRef(new Set());

  useEffect(() => () => {
    sequence.current += 1;
    clearTimeout(resetTimer.current);
    for (const controller of controllers.current) controller.abort();
  }, []);

  const runDownload = async (fileName, timeoutMs, transfer) => {
    const operation = ++sequence.current;
    clearTimeout(resetTimer.current);
    const controller = new AbortController();
    controllers.current.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const update = (state) => {
      if (sequence.current === operation) setDownloadState(state);
    };
    update({ fileName, pending: true, done: false, error: false, message: `${t('download') || 'Download'}...` });
    let error = false;
    try {
      await transfer(controller.signal);
      checkAborted(controller.signal);
      update({ fileName, pending: false, done: true, error: false, message: t('downloadStarted') || 'Download started' });
    } catch (failure) {
      error = true;
      const message = timedOut
        ? '다운로드 응답 시간이 초과되었습니다. 다시 시도해 주세요.'
        : failure.message || t('downloadFailed') || 'Download failed';
      update({ fileName, pending: false, done: true, error: true, message });
    } finally {
      clearTimeout(timer);
      controllers.current.delete(controller);
      if (sequence.current === operation) {
        resetTimer.current = setTimeout(() => {
          if (sequence.current === operation) setDownloadState(null);
        }, error ? 4000 : 2000);
      }
    }
  };

  const checkResponse = async (response, signal) => {
    if (response.ok) return;
    let detail = '';
    if (response.headers.get('content-type')?.includes('json')) {
      try {
        const data = await response.json();
        if (data?.detail) detail = `: ${data.detail}`;
      } catch (failure) {
        if (signal.aborted) throw failure;
      }
    }
    throw new Error(`${t('downloadFailed') || 'Download failed'}${detail || ` (${response.status})`}`);
  };

  const downloadNode = async (path, type) => {
    if (!path) return;
    await runDownload(basename(path), REQUEST_TIMEOUT_MS, async (signal) => {
      // Promote legacy bearer authentication before handing the GET to the browser.
      const headers = authHeaders();
      if (headers.Authorization) {
        const authentication = await fetch('/api/auth/verify', { headers, signal, credentials: 'same-origin' });
        await checkResponse(authentication, signal);
      }
      const url = `${apiBase}/download?path=${encodeURIComponent(path)}`;
      const response = await fetch(url, { method: 'HEAD', signal, credentials: 'same-origin' });
      await checkResponse(response, signal);
      checkAborted(signal);
      const defaultName = type === 'directory' ? `${basename(path)}.zip` : basename(path);
      const filename = filenameFromDisposition(response.headers.get('content-disposition'), defaultName);
      // The browser streams the response to its download manager without a full JS blob.
      triggerDownload(url, filename);
    });
  };

  const downloadZip = async (paths) => {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    if (list.length === 1) return downloadNode(list[0]);
    await runDownload(`${list.length} ${t('items') || 'items'}`, ZIP_TIMEOUT_MS, async (signal) => {
      const response = await fetch(`${apiBase}/download-zip`, {
        method: 'POST', signal, credentials: 'same-origin',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ paths: list }),
      });
      await checkResponse(response, signal);
      const blob = await response.blob();
      checkAborted(signal);
      const url = URL.createObjectURL(blob);
      const filename = filenameFromDisposition(response.headers.get('content-disposition'), `download-${list.length}-items.zip`);
      triggerDownload(url, filename);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  };

  return { downloadState, downloadNode, downloadZip };
}
