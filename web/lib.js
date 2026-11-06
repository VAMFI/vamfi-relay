export const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting']);
export const ONGOING_WORK_STATUSES = new Set(['planned', 'active', 'blocked', 'needs_review']);

export function ongoingWork(snapshot, query = '') {
  return (snapshot.workItems || []).filter((work) => ONGOING_WORK_STATUSES.has(work.status) && matchesQuery([
    work.title, work.objective, work.nextAction,
    snapshot.projects?.find((project) => project.id === work.projectId)?.name,
  ], query)).sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

export function linkedWorkId(snapshot, item) {
  const tasks = snapshot.tasks || [];
  let workId = item.workId;
  let task = tasks.find((entry) => entry.id === (item.taskId || item.id));
  const visited = new Set();
  while (!workId && task && !visited.has(task.id)) {
    visited.add(task.id);
    workId = task.workId;
    task = tasks.find((entry) => entry.id === task.parentTaskId);
  }
  return (snapshot.workItems || []).some((work) => work.id === workId) ? workId : null;
}

export function workTasks(snapshot, workId) {
  return (snapshot.tasks || []).filter((task) => linkedWorkId(snapshot, task) === workId);
}

export function executionCounts(tasks) {
  return {
    running: tasks.filter((task) => ['running', 'waiting'].includes(task.status)).length,
    queued: tasks.filter((task) => task.status === 'queued').length,
    starting: tasks.filter((task) => task.status === 'queued' && task.queueState === 'starting').length,
    held: tasks.filter((task) => task.status === 'queued' && task.queueState === 'held').length,
  };
}

export function attentionWork(snapshot) {
  return (snapshot.workItems || []).filter((work) => ['blocked', 'needs_review'].includes(work.status) || (work.status === 'paused' && work.recoveryRequired === true));
}

export function needsRetryAcknowledgment(work, snapshot) {
  if (work.plan) {
    const nextStep = (work.plan.steps || []).find((step) => step.status !== 'finished');
    return !!nextStep && ['blocked', 'interrupted', 'cancelled'].includes(nextStep.status);
  }
  const tasks = workTasks(snapshot, work.id).filter((task) => task.kind === 'project');
  if (tasks.some((task) => task.status === 'queued' && task.queueState === 'held')) return false;
  const latest = [...tasks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  return !!latest && ['failed', 'interrupted', 'cancelled'].includes(latest.status);
}

export function planNeedsApproval(work, project) {
  return !!work.plan && (!work.plan.approvedAt || work.plan.status === 'draft' || work.plan.approvedPermissionMode !== project?.permissionMode);
}

export function masterMessages(snapshot) {
  const coordinators = new Set((snapshot.threads || []).filter((thread) => thread.role === 'coordinator').map((thread) => thread.id));
  if (snapshot.mainThreadId) coordinators.add(snapshot.mainThreadId);
  return (snapshot.messages || []).filter((message) => message.channel === 'master' || (!message.channel && coordinators.has(message.threadId)));
}

export function goalSummary(snapshot, date) {
  const timeZone = snapshot.meta?.timezone || 'UTC';
  const ongoing = ongoingWork(snapshot);
  const approvals = (snapshot.approvals || []).filter((approval) => approval.status === 'pending');
  const needsYou = attentionWork(snapshot).length + approvals.length;
  const projectIds = new Set((snapshot.projects || []).map((project) => project.id));
  const activeProjects = new Set(ongoing.map((work) => work.projectId).filter((id) => projectIds.has(id))).size;
  const completed = (snapshot.workItems || []).filter((work) => work.status === 'completed' && work.completionNote?.trim() && dayKey(work.completedAt, timeZone) === date);
  const events = (snapshot.events || []).filter((event) => linkedWorkId(snapshot, event) && dayKey(event.createdAt, timeZone) === date);
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const event of events) {
    const hour = Number(displayDate(event.createdAt, { timeZone, hour: '2-digit', hourCycle: 'h23' }));
    if (Number.isInteger(hour) && hours[hour]) hours[hour].count += 1;
  }
  return { ongoing, approvals, needsYou, activeProjects, completed, events, hours };
}

export function dayKey(value, timeZone = 'UTC') {
  const date = new Date(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(date.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function displayDate(value, options = {}) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  try { return new Intl.DateTimeFormat('en-US', options).format(date); }
  catch { return new Intl.DateTimeFormat('en-US').format(date); }
}

export function shiftDay(value, offset) {
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function dateLabel(value, options = {}) {
  return displayDate(`${value}T12:00:00Z`, { timeZone: 'UTC', month: 'long', day: 'numeric', ...options });
}

export function duration(task, now = Date.now()) {
  if (!task.startedAt) return 'Not started';
  const start = new Date(task.startedAt).getTime();
  const end = task.completedAt ? new Date(task.completedAt).getTime() : new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Not recorded';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function matchesQuery(values, query) {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || values.filter(Boolean).join(' ').toLocaleLowerCase().includes(normalized);
}

export function dailySummary(snapshot, date) {
  const timeZone = snapshot.meta?.timezone || 'UTC';
  const tasks = snapshot.tasks || [];
  const onDay = (value) => dayKey(value, timeZone) === date;
  const created = tasks.filter((task) => onDay(task.createdAt));
  const completed = tasks.filter((task) => task.status === 'completed' && onDay(task.completedAt));
  const started = tasks.filter((task) => onDay(task.startedAt));
  const events = (snapshot.events || []).filter((event) => onDay(event.createdAt));
  const approvals = (snapshot.approvals || []).filter((approval) => approval.status === 'pending' && onDay(approval.createdAt));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const event of events) {
    const hour = Number(displayDate(event.createdAt, { timeZone, hour: '2-digit', hourCycle: 'h23' }));
    if (Number.isInteger(hour) && hours[hour]) hours[hour].count += 1;
  }
  return { created, completed, started, events, approvals, workers: created.filter((task) => task.kind === 'worker'), hours };
}

export function normalizeSnapshot(data = {}) {
  return {
    ...data,
    meta: data.meta || {},
    connection: data.connection || { provider: 'codex', status: 'disconnected' },
    settings: data.settings || { workspace: '', permissionMode: 'read-only', maxWorkers: 2 },
    threads: Array.isArray(data.threads) ? data.threads : [],
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    messages: Array.isArray(data.messages) ? data.messages : [],
    events: Array.isArray(data.events) ? data.events : [],
    approvals: Array.isArray(data.approvals) ? data.approvals : [],
    skills: Array.isArray(data.skills) ? data.skills : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    workItems: Array.isArray(data.workItems) ? data.workItems : [],
  };
}
