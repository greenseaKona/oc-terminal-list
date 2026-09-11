export const paneCloseIdentity = (pane) => JSON.stringify([
  pane?.id || '',
  pane?.sessionId || '',
  pane?.hostId || '',
  pane?.tmuxSessionName || '',
  pane?.mode || '',
  pane?.multiplexer || '',
]);

export const tabCloseIdentity = (tab) => JSON.stringify([
  tab?.sessionId || '',
  tab?.hostId || '',
  ...(tab?.panes || []).map(paneCloseIdentity),
]);

export const resolveConfirmedPane = (tabs, tabId, paneId, expectedIdentity) => {
  const tab = tabs.find((item) => item.id === tabId);
  const paneIndex = tab?.panes?.findIndex((pane) => pane.id === paneId) ?? -1;
  if (!tab || paneIndex < 0) return null;
  const pane = tab.panes[paneIndex];
  return paneCloseIdentity(pane) === expectedIdentity ? { tab, pane, paneIndex } : null;
};

export const resolveConfirmedTab = (tabs, tabId, expectedIdentity) => {
  const tab = tabs.find((item) => item.id === tabId);
  return tab && tabCloseIdentity(tab) === expectedIdentity ? tab : null;
};
