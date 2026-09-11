/**
 * Live cwd values reported by the existing per-host remote tmux sweep.
 *
 * The store is separate from React context so one changed pane only wakes cwd
 * subscribers. Keys include the host because tmux session names repeat across hosts.
 */
let state = {};
const listeners = new Set();

const keyOf = (hostId, session) => `${hostId || ''}\u0000${session || ''}`;

export const subscribeRemoteCwd = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getRemoteCwd = (hostId, session) => (
  hostId && session ? (state[keyOf(hostId, session)] || '') : ''
);

export const applyRemoteCwdChanges = (hostId, cwds) => {
  if (!hostId || !cwds || typeof cwds !== 'object') return;
  let next = state;
  for (const [session, cwd] of Object.entries(cwds)) {
    if (!session) continue;
    const key = keyOf(hostId, session);
    if (cwd === null) {
      if (!Object.hasOwn(state, key)) continue;
      if (next === state) next = { ...state };
      delete next[key];
      continue;
    }
    if (typeof cwd !== 'string' || !cwd || getRemoteCwd(hostId, session) === cwd) continue;
    if (next === state) next = { ...state };
    next[key] = cwd;
  }
  if (next === state) return;
  state = next;
  listeners.forEach((listener) => listener());
};

export const _resetRemoteCwd = () => {
  state = {};
  listeners.clear();
};
