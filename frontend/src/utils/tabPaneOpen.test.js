import { describe, it, expect } from 'vitest';
import { appendPaneAsSplit, appendPaneToTab } from './tabPaneOpen';

describe('appendPaneAsSplit', () => {
  it('adds a mobile-created pane inside the same tab as sub-tab state', () => {
    const tab = {
      id: 'tab-1',
      panes: [{ id: 'pane-1', sessionId: 's1' }],
      activePaneId: 'pane-1',
      layout: 'single',
      splitTree: { type: 'pane', paneId: 'pane-1' },
    };

    const next = appendPaneAsSplit(
      tab,
      { id: 'pane-2', sessionId: 's2', cwd: 'src' },
      { afterPaneId: 'pane-1', dir: 'right' },
    );

    expect(next.id).toBe('tab-1');
    expect(next.panes).toHaveLength(2);
    expect(next.activePaneId).toBe('pane-2');
    expect(next.layout).toBe('h');
    expect(JSON.stringify(next.splitTree)).toContain('pane-1');
    expect(JSON.stringify(next.splitTree)).toContain('pane-2');
  });

  it('uses vertical layout for down/up insertion', () => {
    const tab = {
      id: 'tab-1',
      panes: [{ id: 'pane-1', sessionId: 's1' }],
      activePaneId: 'pane-1',
    };

    const next = appendPaneAsSplit(tab, { id: 'pane-2', sessionId: 's2' }, { dir: 'down' });

    expect(next.layout).toBe('v');
  });
});

describe('appendPaneToTab', () => {
  it('adds the same-path terminal to the current tab without creating another tab', () => {
    const tabs = [
      {
        id: 'tab-1',
        panes: [{ id: 'pane-1', sessionId: 's1', cwd: 'src' }],
        activePaneId: 'pane-1',
        splitTree: { type: 'pane', paneId: 'pane-1' },
      },
      {
        id: 'tab-2',
        panes: [{ id: 'pane-3', sessionId: 's3' }],
        activePaneId: 'pane-3',
      },
    ];

    const next = appendPaneToTab(tabs, 'tab-1', { id: 'pane-2', sessionId: 's2', cwd: 'src' });

    expect(next).toHaveLength(2);
    expect(next[0].panes).toHaveLength(2);
    expect(next[0].activePaneId).toBe('pane-2');
    expect(next[1]).toBe(tabs[1]);
  });
});
