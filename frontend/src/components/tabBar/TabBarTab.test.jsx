import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Tab } from './TabBarTab';

const tab = { id: 'tab-1', name: 'Shell', type: 'local', panes: [] };

describe('TabBarTab keyboard navigation', () => {
  it('exposes tab semantics and selects with Enter or Space', () => {
    const onSelect = vi.fn();
    render(<Tab tab={tab} index={0} isActive onSelect={onSelect} t={(key) => key} />);

    const element = screen.getByRole('tab');
    expect(element).toHaveAttribute('aria-selected', 'true');
    expect(element).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(element, { key: 'Enter' });
    fireEvent.keyDown(element, { key: ' ' });

    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith('tab-1');
  });

  it('removes inactive tabs from the roving tab stop', () => {
    render(<Tab tab={tab} index={0} isActive={false} t={(key) => key} />);
    expect(screen.getByRole('tab')).toHaveAttribute('tabindex', '-1');
  });

  it('shows the stable address while keeping the positional shortcut', () => {
    render(<Tab tab={tab} addressNumber={7} shortcutPosition={2} isActive t={(key) => key} />);

    expect(screen.getByText('7')).toHaveAttribute('title', 'switchToTab (Ctrl+2)');
  });
});
