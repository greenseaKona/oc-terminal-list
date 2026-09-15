import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';

describe('ConfirmModal wrapping', () => {
  it('keeps Korean words intact on narrow screens', () => {
    render(
      <ConfirmModal
        isOpen
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        title="상태 충돌"
        message="세션을 종료하기 전에 유지할 탭 구성을 선택하세요."
        language="ko"
      />,
    );

    expect(screen.getByText(/세션을 종료하기 전에/)).toHaveStyle({ wordBreak: 'keep-all' });
  });

  it('focuses the non-destructive defer action when three choices are shown', () => {
    render(
      <ConfirmModal
        isOpen
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onTertiary={vi.fn()}
        title="State conflict"
        message="Choose a workspace."
        confirmText="Keep local"
        cancelText="Decide later"
        tertiaryText="Use server"
      />,
    );

    const defer = screen.getByRole('button', { name: 'Decide later' });
    expect(defer).toHaveAttribute('data-modal-initial-focus', 'true');
    expect(defer).toHaveFocus();
    expect(defer).not.toHaveStyle({ outline: 'none' });
  });
});
