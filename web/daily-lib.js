import { ACTIVE_STATUSES, dayKey, matchesQuery } from './lib.js';

/** A read-only view of recorded work. Never infer ownership from matching text. */
export function dailyWork(snapshot, date, query = '') {
  const tasks = snapshot.tasks || [];
  const works = snapshot.workItems || [];
  const events = snapshot.events || [];
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const workById = new Map(works.map(work => [work.id, work]));
  const projectById = new Map((snapshot.projects || []).map(project => [project.id, project]));
  const timeZone = snapshot.meta?.timezone || 'UTC';
  const onDay = value => dayKey(value, timeZone) === date;
  const newest = (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
  const ancestry = task => {
    const chain = [], seen = new Set();
    while (task && !seen.has(task.id)) {
      chain.push(task); seen.add(task.id); task = taskById.get(task.parentTaskId);
    }
    return chain;
  };
  const taskWork = task => {
    const record = ancestry(task).find(item => workById.has(item.workId));
    return workById.get(record?.workId) || null;
  };
  const context = work => [work?.title, work?.objective, work?.nextAction, projectById.get(work?.projectId)?.name];
  const requestGoals = new Map();
  const linkRequest = (task, work) => {
    if (task?.kind !== 'request' || !work) return;
    if (!requestGoals.has(task.id)) requestGoals.set(task.id, new Map());
    requestGoals.get(task.id).set(work.id, work);
  };
  for (const event of events) {
    if (event.type === 'work_request') linkRequest(taskById.get(event.taskId), workById.get(event.workId));
  }
  for (const task of tasks) {
    if (['project', 'worker'].includes(task.kind)) linkRequest(ancestry(task).find(item => item.kind === 'request'), taskWork(task));
  }
  const userMessages = new Map((snapshot.messages || []).filter(m => m.role === 'user').map(m => [m.taskId, m]));
  const requests = [...requestGoals].flatMap(([taskId, linked]) => {
    const task = taskById.get(taskId), message = userMessages.get(taskId);
    const createdAt = message?.createdAt || task.createdAt;
    const text = message?.text || task.prompt || 'Original request not recorded';
    const goals = [...linked.values()];
    return onDay(createdAt) && matchesQuery([text, ...goals.flatMap(context)], query)
      ? [{ id: taskId, taskId, text, createdAt, goals }] : [];
  }).sort(newest);

  const assignments = tasks.filter(task => ['project', 'worker'].includes(task.kind) && ACTIVE_STATUSES.has(task.status)).map(task => {
    const work = taskWork(task);
    const project = projectById.get(task.projectId || work?.projectId) || null;
    const plan = [work?.plan, ...(work?.planHistory || [])].find(plan => plan?.id === task.planId);
    return {
      task, work, project, parent: taskById.get(task.parentTaskId) || null,
      provider: task.provider === 'codex' ? 'Codex' : task.provider === 'hermes' ? 'Hermes' : task.provider || 'Codex · legacy record',
      role: task.kind === 'worker' ? 'Background specialist' : 'Project executor',
      permissionMode: task.permissionMode || 'Not recorded',
      state: task.status === 'queued' && ['held', 'starting'].includes(task.queueState) ? task.queueState : task.status,
      summary: task.error || task.checkpoint?.summary || task.result || task.queueReason || '',
      step: plan?.steps?.find(step => step.id === task.stepId) || null,
    };
  }).filter(item => matchesQuery([item.task.title, item.task.prompt, item.project?.name, item.role, ...context(item.work)], query))
    .sort((a, b) => Number(['running', 'waiting'].includes(b.task.status)) - Number(['running', 'waiting'].includes(a.task.status)) || newest(a.task, b.task));

  const progress = [];
  const add = item => {
    const work = workById.get(item.workId);
    if (work && onDay(item.createdAt) && matchesQuery([item.text, item.label, ...context(work)], query)) progress.push(item);
  };
  for (const task of tasks) {
    const work = taskWork(task);
    if (work && ['project', 'worker'].includes(task.kind) && ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) {
      add({ id: `run:${task.id}`, kind: 'report', label: task.status === 'completed' ? 'Agent report · run finished' : `Run ${task.status}`,
        text: task.error || task.result || task.checkpoint?.summary || 'No result text recorded. Inspect the execution.',
        createdAt: task.completedAt, workId: work.id, taskId: task.id });
    }
  }
  for (const event of events) {
    const work = workById.get(event.workId) || taskWork(taskById.get(event.taskId));
    if (event.type === 'work_review') {
      add({ id: `review:${event.id}`, kind: 'review', label: 'User-reviewed completion', text: event.detail,
        createdAt: event.createdAt, workId: work?.id, taskId: null });
    } else if (['commandExecution', 'fileChange'].includes(event.type)) {
      add({ id: `observation:${event.id}`, kind: 'observation', label: event.type === 'commandExecution' ? 'Observed command activity' : 'Observed file activity',
        text: event.type === 'commandExecution' ? 'Inspect the execution for the recorded command, exit status and output.' : 'Inspect the execution for the recorded file changes.',
        createdAt: event.createdAt, workId: work?.id, taskId: event.taskId || null });
    }
  }
  for (const work of works) {
    add({ id: `goal:${work.id}`, kind: 'goal', label: 'Goal added', text: work.title, createdAt: work.createdAt, workId: work.id, taskId: null });
    for (const note of work.notes || []) add({ id: `note:${note.id}`, kind: 'note', label: 'External progress note', text: note.text, createdAt: note.createdAt, workId: work.id, taskId: null });
    // Older records have a current completion note but no immutable review event.
    if (work.status === 'completed' && work.completionNote?.trim() && !events.some(event => event.type === 'work_review' && event.workId === work.id && event.createdAt === work.completedAt)) {
      add({ id: `legacy-review:${work.id}`, kind: 'review', label: 'User-reviewed completion · legacy record', text: work.completionNote, createdAt: work.completedAt, workId: work.id, taskId: null });
    }
  }
  progress.sort(newest);
  return { requests, progress, assignments, reviewed: progress.filter(item => item.kind === 'review') };
}
