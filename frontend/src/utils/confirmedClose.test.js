import { describe, expect, it } from 'vitest';
import {
  paneCloseIdentity,
  resolveConfirmedPane,
  resolveConfirmedTab,
  tabCloseIdentity,
} from './confirmedClose';

const pane = (id, sessionId) => ({ id, mode: 'terminal', sessionId });
const tab = (id, panes) => ({ id, panes });

describe('confirmed close target resolution', () => {
  it('rejects a pane whose session changed while confirmation was open', () => {
    const original = pane('p1', 'old-session');
    const current = tab('t1', [pane('p1', 'new-session')]);

    expect(resolveConfirmedPane([current], 't1', 'p1', paneCloseIdentity(original))).toBeNull();
  });

  it('rejects a tab whose session composition changed while confirmation was open', () => {
    const original = tab('t1', [pane('p1', 's1'), pane('p2', 's2')]);
    const current = tab('t1', [pane('p1', 's1'), pane('p2', 's3')]);

    expect(resolveConfirmedTab([current], 't1', tabCloseIdentity(original))).toBeNull();
  });

  it('returns the latest object when its close identity is unchanged', () => {
    const original = tab('t1', [pane('p1', 's1')]);
    const current = { ...original, name: 'renamed' };

    expect(resolveConfirmedTab([current], 't1', tabCloseIdentity(original))).toBe(current);
  });
});
