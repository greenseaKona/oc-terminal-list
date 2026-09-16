const now = Math.floor(Date.now() / 1000);

const usageSummary = {
  window_days: 7,
  total_seconds: 91200,
  session_count: 28,
  avg_session_seconds: 3257,
  active_targets: 4,
  by_day: [
    { day: '2026-09-10', seconds: 8400 },
    { day: '2026-09-11', seconds: 12600 },
    { day: '2026-09-12', seconds: 10800 },
    { day: '2026-09-13', seconds: 17100 },
    { day: '2026-09-14', seconds: 9300 },
    { day: '2026-09-15', seconds: 19200 },
    { day: '2026-09-16', seconds: 13800 },
  ],
  by_target: [
    { target_type: 'local', target_id: 'local', total_seconds: 31800 },
    { target_type: 'host', target_id: 'demo-web', total_seconds: 26700 },
    { target_type: 'host', target_id: 'demo-edge', total_seconds: 19200 },
    { target_type: 'host', target_id: 'demo-db', total_seconds: 13500 },
  ],
};

const fleet = {
  machines: [
    { id: 'local', reachable: true, paneCount: 1, uptimeSeconds: 9 * 86400, memUsed: 6.2 * 1024 ** 3, memTotal: 16 * 1024 ** 3 },
    { id: 'demo-web', reachable: true, paneCount: 2, uptimeSeconds: 24 * 86400, memUsed: 3.8 * 1024 ** 3, memTotal: 8 * 1024 ** 3 },
    { id: 'demo-edge', reachable: true, paneCount: 1, uptimeSeconds: 41 * 86400, memUsed: 1.4 * 1024 ** 3, memTotal: 4 * 1024 ** 3 },
  ],
  targets: [
    { tabIndex: 1, paneIndex: 1, addr: '1.1', kind: 'local', sessionId: 'demo-local', cwd: '/home/demo/app', status: 'working', title: 'npm run build', command: 'node', startedAt: now - 7200, memBytes: 740 * 1024 ** 2 },
    { tabIndex: 2, paneIndex: 1, addr: '2.1', kind: 'host', hostId: 'demo-web', cwd: '/srv/web', status: 'permission', title: 'Deploy approval', command: './deploy.sh', startedAt: now - 3900, memBytes: 410 * 1024 ** 2 },
    { tabIndex: 3, paneIndex: 1, addr: '3.1', kind: 'host', hostId: 'demo-db', cwd: '/var/lib/redis', status: 'idle', title: 'redis monitor', command: 'redis-cli', startedAt: now - 18600, memBytes: 92 * 1024 ** 2 },
    { tabIndex: 4, paneIndex: 1, addr: '4.1', kind: 'host', hostId: 'demo-edge', cwd: '/home/demo', status: 'working', title: 'Edge health check', command: 'htop', startedAt: now - 26400, memBytes: 186 * 1024 ** 2 },
  ],
};

const json = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

export const installDemoApi = () => {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, window.location.origin);
    if (url.pathname === '/api/usage/summary') return Promise.resolve(json(usageSummary));
    if (url.pathname === '/api/fleet') return Promise.resolve(json(fleet));
    if (url.pathname === '/api/llm-usage/summary' || url.pathname === '/api/llm-usage/refresh') {
      return Promise.resolve(json({ enabled: false }));
    }
    return originalFetch(input, init);
  };
};
