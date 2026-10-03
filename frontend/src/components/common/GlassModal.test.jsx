import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import GlassModal from './GlassModal';

describe('GlassModal keyboard behavior', () => {
  it('is not globally forced fullscreen on mobile', () => {
    // jsdom does not evaluate media queries, so guard the app-shell rule that can
    // override every caller's inline dialog size only when it uses !important.
    const appSource = readFileSync(resolve(process.cwd(), 'src/App.jsx'), 'utf8');
    expect(appSource).not.toContain('.iterm-glass-overlay { padding: 0 !important; }');
    expect(appSource).not.toMatch(/\.iterm-glass-modal\s*\{[^}]*height:\s*100%\s*!important/s);
  });

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
