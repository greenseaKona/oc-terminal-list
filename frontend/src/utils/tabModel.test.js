import { describe, it, expect } from 'vitest';
import {
  deriveTabPrimaryIdentity,
  deriveTabSecondaryIdentities,
  getActivePane,
  makLocalTab,
  makeHostTab,
  migrateTab,
  paneIdentityKey,
  resolvePaneLaunchSource,
  stabilizeTabAddresses,
} from './tabModel';

const HOSTS = [
  { id: 'h-argon', name: 'ArgonEON', icon: null, color_index: 36 },
  { id: 'h-pve', name: 'Proxmox VE', icon: 'Atom', color_index: 44 },
  { id: 'h-nas', name: 'TrueNAS Scale', icon: 'PieChart', color_index: 13 },
];

describe('getActivePane', () => {
  it('returns the active pane instead of the first pane', () => {
    const first = { id: 'pane-1', cwd: 'stale' };
    const active = { id: 'pane-2', cwd: 'current' };

    expect(getActivePane({ panes: [first, active], activePaneId: active.id })).toBe(active);
  });

  it('falls back to the first pane for legacy tab state', () => {
    const first = { id: 'pane-1' };

    expect(getActivePane({ panes: [first], activePaneId: 'missing' })).toBe(first);
  });
});

describe('tab factories — pane cwd ownership', () => {
  it('stores a selected local path on both the tab and its pane', () => {
    const created = makLocalTab('s1', 'project', 'project/sub');
    expect(created.cwd).toBe('project/sub');
    expect(created.panes[0].cwd).toBe('project/sub');
  });

  it('preserves the empty local workspace-root path', () => {
    expect(makLocalTab('s1', 'terminal', '').panes[0].cwd).toBe('');
  });

  it('stores a selected remote absolute path on the host pane', () => {
    const created = makeHostTab({ id: 'h1', name: 'box' }, '/srv/project');
    expect(created.panes[0].cwd).toBe('/srv/project');
  });
});

describe('paneIdentityKey', () => {
  it('groups host panes by hostId and local panes as one identity', () => {
    expect(paneIdentityKey({ hostId: 'h-pve' })).toBe('host:h-pve');
    expect(paneIdentityKey({ sessionId: 's1' })).toBe('local');
    expect(paneIdentityKey({})).toBeNull();
  });
});

describe('resolvePaneLaunchSource', () => {
  it('keeps an active local pane local inside a host-origin tab', () => {
    const tab = { type: 'host', hostId: 'h-argon', cwd: '/srv/stale' };

    expect(resolvePaneLaunchSource(tab, { sessionId: 'local-1' })).toEqual({ hostId: null, cwd: null });
  });

  it('does not inherit another host path for an active pane from a different host', () => {
    const tab = { type: 'host', hostId: 'h-argon', cwd: '/srv/argon' };

    expect(resolvePaneLaunchSource(tab, { hostId: 'h-pve' })).toEqual({ hostId: 'h-pve', cwd: null });
  });

  it('uses tab metadata only for a legacy pane without its own identity', () => {
    const tab = { type: 'host', hostId: 'h-argon', cwd: '/srv/argon' };

    expect(resolvePaneLaunchSource(tab, {})).toEqual({ hostId: 'h-argon', cwd: '/srv/argon' });
  });
});

describe('stabilizeTabAddresses', () => {
  it('preserves assigned numbers and fills the lowest free numbers', () => {
    const tabs = stabilizeTabAddresses([
      { id: 't3', addressNumber: 3, panes: [
        { id: 'p3', addressNumber: 3 },
        { id: 'new-pane' },
      ] },
      { id: 'new-tab', panes: [{ id: 'p1' }] },
      { id: 't1', addressNumber: 1, panes: [{ id: 'p1', addressNumber: 1 }] },
    ]);

    expect(tabs.map((item) => item.addressNumber)).toEqual([3, 2, 1]);
    expect(tabs[0].panes.map((item) => item.addressNumber)).toEqual([3, 1]);
    expect(tabs[1].panes[0].addressNumber).toBe(1);
  });

  it('keeps object identity when every address is already stable', () => {
    const tabs = [{ id: 't1', addressNumber: 4, panes: [{ id: 'p1', addressNumber: 7 }] }];
    expect(stabilizeTabAddresses(tabs)).toBe(tabs);
  });
});

describe('deriveTabSecondaryIdentities', () => {
  it('returns empty for a single-pane tab', () => {
    const tab = { panes: [{ id: 'p1', hostId: 'h-pve' }], activePaneId: 'p1' };
    expect(deriveTabSecondaryIdentities(tab, HOSTS)).toEqual([]);
  });

  it('returns empty when all panes share the same host', () => {
    const tab = {
      panes: [{ id: 'p1', hostId: 'h-pve' }, { id: 'p2', hostId: 'h-pve' }],
      activePaneId: 'p1',
    };
    expect(deriveTabSecondaryIdentities(tab, HOSTS)).toEqual([]);
  });

  it('returns the non-active host meta when two hosts are mixed', () => {
    const tab = {
      panes: [{ id: 'p1', hostId: 'h-argon' }, { id: 'p2', hostId: 'h-pve' }],
      activePaneId: 'p2',
    };
    expect(deriveTabSecondaryIdentities(tab, HOSTS)).toEqual([
      { kind: 'host', name: 'ArgonEON', icon: '', colorIndex: 36 },
    ]);
  });

  it('returns every distinct non-active identity in pane order, deduped', () => {
    const tab = {
      panes: [
        { id: 'p1', hostId: 'h-pve' },
        { id: 'p2', hostId: 'h-argon' },
        { id: 'p3', hostId: 'h-nas' },
        { id: 'p4', hostId: 'h-argon' }, // 중복 — 한 번만
      ],
      activePaneId: 'p1',
    };
    expect(deriveTabSecondaryIdentities(tab, HOSTS).map((s) => s.name)).toEqual([
      'ArgonEON', 'TrueNAS Scale',
    ]);
  });

  it('returns local meta when a host pane mixes with a local pane', () => {
    const tab = {
      panes: [{ id: 'p1', hostId: 'h-pve' }, { id: 'p2', sessionId: 's1' }],
      activePaneId: 'p1',
    };
    const settings = { localName: 'dev-box', localIcon: 'Monitor', localColorIndex: 24 };
    expect(deriveTabSecondaryIdentities(tab, HOSTS, settings)).toEqual([
      { kind: 'local', name: 'dev-box', icon: 'Monitor', colorIndex: 24 },
    ]);
  });

  it('ignores empty panes (no session, no host)', () => {
    const tab = {
      panes: [{ id: 'p1', hostId: 'h-pve' }, { id: 'p2' }],
      activePaneId: 'p1',
    };
    expect(deriveTabSecondaryIdentities(tab, HOSTS)).toEqual([]);
  });
});

describe('deriveTabPrimaryIdentity', () => {
  it('follows the active host pane', () => {
    const tab = {
      panes: [{ id: 'p1', hostId: 'h-argon' }, { id: 'p2', hostId: 'h-pve' }],
      activePaneId: 'p2',
    };
    expect(deriveTabPrimaryIdentity(tab, HOSTS)).toEqual(
      { kind: 'host', name: 'Proxmox VE', icon: 'Atom', colorIndex: 44 },
    );
  });

  it('follows the active local pane even inside a host tab (no host duplicate)', () => {
    // 버그 재현: 호스트 탭에서 활성 pane 이 로컬이면 주 타일이 탭 호스트로 폴백해
    // secondaries(호스트 포함)와 같은 아이콘이 두 번 보였다. 주 정체성은 로컬이어야 한다.
    const tab = {
      type: 'host', hostId: 'h-argon',
      panes: [{ id: 'p1', hostId: 'h-argon' }, { id: 'p2', sessionId: 's1' }, { id: 'p3', hostId: 'h-nas' }],
      activePaneId: 'p2',
    };
    const settings = { localName: 'dev-box', localIcon: 'Monitor', localColorIndex: 24 };
    expect(deriveTabPrimaryIdentity(tab, HOSTS, settings)).toEqual(
      { kind: 'local', name: 'dev-box', icon: 'Monitor', colorIndex: 24 },
    );
    // 그때 secondaries 는 로컬을 빼고 두 호스트만 — 합치면 세 정체성이 정확히 한 번씩.
    expect(deriveTabSecondaryIdentities(tab, HOSTS, settings).map((s) => s.name)).toEqual(
      ['ArgonEON', 'TrueNAS Scale'],
    );
  });

  it('returns null when the active host is not in the hosts list', () => {
    const tab = { panes: [{ id: 'p1', hostId: 'h-gone' }], activePaneId: 'p1' };
    expect(deriveTabPrimaryIdentity(tab, HOSTS)).toBeNull();
  });

  it('returns null for an empty pane', () => {
    const tab = { panes: [{ id: 'p1' }], activePaneId: 'p1' };
    expect(deriveTabPrimaryIdentity(tab, HOSTS)).toBeNull();
  });
});

describe('migrateTab — VNC pane restoration', () => {
  it('materializes a legacy tab-only cwd only on panes from the same machine', () => {
    const migrated = migrateTab({
      id: 'local:s1',
      type: 'local',
      cwd: 'project',
      panes: [{ id: 'local-pane', sessionId: 's1' }, { id: 'remote-pane', hostId: 'h1' }],
      splitTree: { type: 'leaf', id: 'local-pane' },
    });
    expect(migrated.panes[0].cwd).toBe('project');
    expect(migrated.panes[1].cwd).toBeUndefined();
  });

  it('preserves mode/hostId/display through the restore path', () => {
    // 서버 tab-state 에서 받은 VNC pane 이 migrateTab 을 거쳐도 필드가 살아있어야
    // 새로고침 후 VncPane 이 다시 렌더된다 (Phase 7 회귀 방지).
    const tab = {
      id: 'host:h1:1',
      type: 'host',
      hostId: 'h1',
      name: 'server · remote desktop',
      panes: [
        { id: 'p1', mode: 'vnc', hostId: 'h1', display: 2 },
      ],
      layout: 'single',
      splitTree: { type: 'leaf', id: 'p1' },
      activePaneId: 'p1',
    };
    const migrated = migrateTab({ ...tab });
    expect(migrated.panes[0].mode).toBe('vnc');
    expect(migrated.panes[0].hostId).toBe('h1');
    expect(migrated.panes[0].display).toBe(2);
  });

  it('preserves VNC pane alongside a terminal pane in a split tab', () => {
    const tab = {
      id: 'local:s1',
      type: 'local',
      sessionId: 's1',
      panes: [
        { id: 'p0', mode: 'terminal', sessionId: 's1' },
        { id: 'p1', mode: 'vnc', hostId: 'h1', display: 1 },
      ],
      splitTree: { type: 'split', direction: 'horizontal', children: [
        { type: 'leaf', id: 'p0' },
        { type: 'leaf', id: 'p1' },
      ] },
      activePaneId: 'p1',
    };
    const migrated = migrateTab({ ...tab });
    expect(migrated.panes[1].mode).toBe('vnc');
    expect(migrated.panes[1].hostId).toBe('h1');
    expect(migrated.panes[1].display).toBe(1);
  });
});
