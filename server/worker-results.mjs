const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Mutates the same state transaction as the terminal result or restart recovery. */
export function reconcileWorkerResult(state, task) {
  if (task.kind !== 'worker' || task.deliveryMode !== 'background' || !TERMINAL.has(task.status)) return;
  const messageId = `worker-result:${task.id}`;
  const existing = state.messages.find(message => message.id === messageId);
  if (existing) { task.notifiedAt ||= existing.createdAt; return; }
  const createdAt = task.completedAt || new Date().toISOString();
  const project = state.projects.find(project => project.id === task.projectId);
  const summary = task.error || task.result || (task.status === 'completed'
    ? 'The specialist finished without a final summary. Inspect its activity before relying on the result.'
    : 'No final result was observed. Inspect the assignment before starting new work.');
  state.messages.push({ id: messageId, threadId: task.threadId || task.requestThreadId || null,
    taskId: task.id, parentTaskId: task.parentTaskId, projectId: task.projectId, workId: task.workId,
    channel: 'master', source: 'worker', role: 'assistant', status: 'complete', outcomeStatus: task.status,
    text: `${project ? project.name + ' · ' : ''}${task.title}\nSpecialist ${task.status}. This report is not goal acceptance.\n\n${String(summary).slice(0, 12000)}`,
    createdAt });
  task.notifiedAt = createdAt;
}
