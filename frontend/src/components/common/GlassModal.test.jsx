import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import GlassModal from './GlassModal';

describe('GlassModal keyboard behavior', () => {
  it('marks the dialog modal, focuses its first action, and closes with Escape', () => {
    const onClose = vi.fn();
    render(
      <GlassModal isOpen onClose={onClose} title="Safe close">
        <button type="button">Choose</button>
      </GlassModal>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Choose' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses an explicit safe initial action and includes dismiss in the focus cycle', () => {
    render(
      <GlassModal isOpen onClose={vi.fn()} title="Safe close">
        <button type="button">First</button>
        <button type="button" data-modal-initial-focus>Last</button>
      </GlassModal>,
    );
    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('button', { name: 'Last' });
    const dismiss = screen.getByRole('button', { name: 'Close' });

    expect(last).toHaveFocus();

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dismiss).toHaveFocus();

    dismiss.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });
});
