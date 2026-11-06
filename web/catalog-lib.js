export function catalogActivity(thread = {}) {
  if (thread.ownership === 'relay' && thread.activity?.basis === 'relay-run' && thread.activity.state === 'active') return { state: 'active', label: 'Active in Relay' };
  if (thread.ownership === 'relay' && thread.activity?.basis === 'relay-run' && thread.activity.state === 'idle') return { state: 'idle', label: 'No active Relay run' };
  return { state: 'unknown', label: 'Live status unknown' };
}

export function filterCatalogThreads(threads, { query = '', projectKey = '', activity = 'all' } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return threads.filter(thread => (!projectKey || thread.projectKey === projectKey)
    && (activity === 'all' || catalogActivity(thread).state === activity)
    && (!needle || [thread.title, thread.preview, thread.projectName, thread.workspace].some(value => String(value || '').toLocaleLowerCase().includes(needle))));
}

function timestamp(value) {
  if (value == null || value === '') return 0;
  const parsed = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function groupCatalogThreads(threads) {
  const groups = new Map();
  for (const thread of [...threads].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))) {
    const key = thread.projectKey || 'unassigned';
    if (!groups.has(key)) groups.set(key, { key, name: thread.projectName || 'Unassigned chats', workspace: thread.workspace, threads: [] });
    groups.get(key).threads.push(thread);
  }
  return [...groups.values()];
}

export function formatCatalogDate(value) {
  const parsed = timestamp(value);
  return parsed ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(parsed) : 'Not recorded';
}

export function handoffIdentity(previous, { threadId, contextHash, request }, uuid = () => crypto.randomUUID()) {
  const key = JSON.stringify([threadId, contextHash, request]);
  return previous?.key === key ? previous : { key, requestId: uuid() };
}

export function canAutoRefreshCatalog({ sample, active, visibilityState, busy, olderHistoryLoaded }) {
  return !sample && active && visibilityState === 'visible' && !busy && !olderHistoryLoaded;
}
