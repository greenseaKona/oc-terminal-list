import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import LocalFolderPicker from './LocalFolderPicker';

const mockT = (key) => key;

describe('LocalFolderPicker skeleton loading', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows skeleton rows while loading', async () => {
    let resolveFetch;
    global.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));

    const { container } = render(
      <LocalFolderPicker
        isOpen={true}
        onPick={vi.fn()}
        onClose={vi.fn()}
        t={mockT}
      />
    );

    await waitFor(() => {
      const skeletons = container.querySelectorAll('[aria-busy="true"]');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    resolveFetch({ ok: true, json: () => Promise.resolve({ items: [] }) });
  });

  it('shows folder items when loaded', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: [{ name: 'Documents', path: 'Documents', type: 'directory' }] }),
      })
    );

    render(
      <LocalFolderPicker
        isOpen={true}
        onPick={vi.fn()}
        onClose={vi.fn()}
        t={mockT}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Documents')).toBeInTheDocument();
    });
  });

  it('has min-height on body container while loading', async () => {
    let resolveFetch;
    global.fetch = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));

    const { container } = render(
      <LocalFolderPicker
        isOpen={true}
        onPick={vi.fn()}
        onClose={vi.fn()}
        t={mockT}
      />
    );

    await waitFor(() => {
      const body = container.querySelector('[style*="min-height"]');
      expect(body).toBeTruthy();
    });

    resolveFetch({ ok: true, json: () => Promise.resolve({ items: [] }) });
  });
});

describe('LocalFolderPicker 숨김 폴더', () => {
  const listing = {
    ok: true,
    json: () => Promise.resolve({
      items: [
        { name: '.git', path: '.git', type: 'directory' },
        { name: 'src', path: 'src', type: 'directory' },
        { name: '.cache', path: '.cache', type: 'directory' },
        { name: 'readme.md', path: 'readme.md', type: 'file' },
      ],
    }),
  };

  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    window.localStorage.clear();
    global.fetch = vi.fn(() => Promise.resolve(listing));
  });
  afterEach(() => { global.fetch = originalFetch; });

  const open = () => render(
    <LocalFolderPicker isOpen onPick={vi.fn()} onClose={vi.fn()} t={mockT} />
  );

  it('기본적으로 점 폴더를 감춘다', async () => {
    open();
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    expect(screen.queryByText('.git')).toBeNull();
    expect(screen.queryByText('.cache')).toBeNull();
  });

  it('토글을 누르면 보여주고, 다시 누르면 감춘다', async () => {
    open();
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle(/showHidden/));
    expect(screen.getByText('.git')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('hideHidden'));
    expect(screen.queryByText('.git')).toBeNull();
  });

  it('숨긴 개수를 버튼 제목에 적는다 — 뭔가 걸러졌다는 걸 알 수 있게', async () => {
    open();
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    expect(screen.getByTitle('showHidden (2)')).toBeInTheDocument();
  });

  it('선택은 다음에 열 때도 유지된다', async () => {
    const first = open();
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    fireEvent.click(screen.getByTitle(/showHidden/));
    first.unmount();

    open();
    await waitFor(() => expect(screen.getByText('.git')).toBeInTheDocument());
  });

  it('전부 숨김이면 "폴더 없음" 이 아니라 그렇다고 말한다', async () => {
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ items: [{ name: '.git', path: '.git', type: 'directory' }] }),
    }));
    open();
    await waitFor(() => expect(screen.getByText('onlyHiddenHere')).toBeInTheDocument());
    expect(screen.queryByText('emptyFolder')).toBeNull();
  });
});

describe('LocalFolderPicker 닫혔다 열기 — 훅 순서 회귀', () => {
  /* 앱에서 이 픽커는 App 에서 **항상 마운트된 채** 닫힌 상태로 살다가 열린다.
     useState/useCallback 이 조기 return(if (!isOpen) return null) 뒤에 있으면
     닫힌 렌더와 열린 렌더의 훅 개수가 어긋나 React 가 "#310 Rendered more hooks
     than during the previous render" 를 던져 픽커가 아예 뜨지 않았다(2026-09-09 버그).
     이 describe 의 테스트는 전부 그 시퀀스(닫힘 마운트 → rerender 로 열림)를 밟는다. */
  const listing = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      items: [{ name: 'Documents', path: 'Documents', type: 'directory' }],
    }),
  });

  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn(listing);
  });
  afterEach(() => { global.fetch = originalFetch; });

  it('닫힌 채 마운트된 뒤 열려도 목록을 띄운다', async () => {
    const { rerender } = render(
      <LocalFolderPicker isOpen={false} onPick={vi.fn()} onClose={vi.fn()} t={mockT} />
    );
    rerender(
      <LocalFolderPicker isOpen onPick={vi.fn()} onClose={vi.fn()} t={mockT} />
    );
    await waitFor(() => expect(screen.getByText('Documents')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalled();
  });

  it('열렸다 닫았다 다시 열어도 산다', async () => {
    const props = { onPick: vi.fn(), onClose: vi.fn(), t: mockT };
    const { rerender } = render(<LocalFolderPicker isOpen={false} {...props} />);
    rerender(<LocalFolderPicker isOpen {...props} />);
    await waitFor(() => expect(screen.getByText('Documents')).toBeInTheDocument());
    rerender(<LocalFolderPicker isOpen={false} {...props} />);
    rerender(<LocalFolderPicker isOpen {...props} />);
    await waitFor(() => expect(screen.getByText('Documents')).toBeInTheDocument());
  });
});
