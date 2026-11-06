import { active, id, timestamp } from './store.mjs';
import { normalizeWorkspace, redact } from './security.mjs';

const PERMISSIONS = new Set(['read-only', 'workspace-write']);
const STATUSES = new Set(['planned', 'active', 'blocked', 'needs_review', 'paused', 'completed', 'cancelled']);
const MODEL_STATUSES = new Set(['planned', 'active', 'blocked', 'needs_review']);

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function inputObject(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Supply an object with the supported fields.');
  if (Object.keys(input).some(key => !fields.includes(key))) fail('Unsupported field in request.');
  if (JSON.stringify(redact(input)) !== JSON.stringify(input)) fail('This input appears to contain a credential. Remove it before saving.');
}

function text(value, field, limit, { optional = false } = {}) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim()) || value.includes('\0')) {
    fail(`${field} must contain ${optional ? '0' : '1'}–${limit} characters.`);
  }
  return value.trim();
}

function permission(value) {
  if (!PERMISSIONS.has(value)) fail('Choose read-only or workspace-write.');
  return value;
}

const sameName = (a, b) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();

function linkedActiveTasks(state, workId) {
  const linked = new Set(state.tasks.filter(task => task.workId === workId).map(task => task.id));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const task of state.tasks) {
      if (linked.has(task.parentTaskId) && !linked.has(task.id)) {
        linked.add(task.id);
        expanded = true;
      }
    }
  }
  return state.tasks.filter(task => linked.has(task.id) && active(task));
}

/** Durable user work definitions. Provider execution and evidence belong to Runtime. */
export class WorkBoard {
  constructor(store) { this.store = store; }

  project(projectId) {
    const project = this.store.state.projects.find(item => item.id === projectId);
    if (!project) fail('Project not found.', 404);
    return project;
  }

  get(workId) {
    const work = this.store.state.workItems.find(item => item.id === workId);
    if (!work) fail('Work item not found.', 404);
    return work;
  }

  async registerProject(input) {
    inputObject(input, ['name', 'workspace', 'permissionMode']);
    const name = text(input.name, 'Project name', 100);
    const permissionMode = permission(input.permissionMode === undefined ? 'read-only' : input.permissionMode);
    const workspace = await normalizeWorkspace(input.workspace);
    // Check after the asynchronous directory validation so concurrent registrations converge.
    const existing = this.store.state.projects.find(project => project.workspace === workspace);
    if (existing) return existing;
    if (this.store.state.projects.some(project => sameName(project.name, name))) fail('A different project already uses that name.', 409);
    const now = timestamp();
    const project = { id: id(), name, workspace, permissionMode, threadId: null, createdAt: now, updatedAt: now };
    this.store.change(state => {
      state.projects.push(project);
      this.store.event('project', 'Project registered', name, { projectId: project.id });
    });
    return this.project(project.id);
  }

  updateProject(projectId, input) {
    inputObject(input, ['name', 'permissionMode']);
    const project = this.project(projectId);
    const patch = {};
    if ('name' in input) patch.name = text(input.name, 'Project name', 100);
    if ('permissionMode' in input) patch.permissionMode = permission(input.permissionMode);
    if (patch.name && this.store.state.projects.some(item => item.id !== projectId && sameName(item.name, patch.name))) {
      fail('A different project already uses that name.', 409);
    }
    const projectWork = this.store.state.workItems.filter(work => work.projectId === projectId);
    if (this.store.state.tasks.some(task => task.projectId === projectId && active(task))
      || projectWork.some(work => linkedActiveTasks(this.store.state, work.id).length)) {
      fail('Wait for this project’s active runs to finish before changing its settings.', 409);
    }
    if (!Object.keys(patch).length) return project;
    this.store.change(() => {
      Object.assign(project, patch, { updatedAt: timestamp() });
      this.store.event('project', 'Project settings updated', project.name, { projectId });
    });
    return this.project(projectId);
  }

  createWork(input) {
    inputObject(input, ['projectId', 'title', 'objective', 'nextAction']);
    const project = this.project(input.projectId);
    const now = timestamp();
    const work = {
      id: id(), projectId: project.id,
      title: text(input.title, 'Title', 120), objective: text(input.objective, 'Objective', 4000),
      nextAction: text(input.nextAction, 'Next action', 1000, { optional: true }),
      status: 'planned', createdAt: now, updatedAt: now, completedAt: null, evidence: [],
      notes: [], plan: null, planHistory: [], recoveryRequired: false,
    };
    const existing = this.store.state.workItems.find(item => item.projectId === work.projectId
      && !['completed', 'cancelled'].includes(item.status) && item.title === work.title && item.objective === work.objective);
    if (existing) return existing;
    this.store.change(state => {
      state.workItems.push(work);
      this.store.event('work', 'Work planned', work.title, { projectId: project.id, workId: work.id });
    });
    return this.get(work.id);
  }

  setPlan(workId, input, { actor = 'user' } = {}) {
    inputObject(input, ['steps']);
    const work = this.get(workId);
    if (['completed', 'cancelled'].includes(work.status)) fail('Reopen this work before drafting a plan.', 409);
    if (actor !== 'user' && work.status === 'paused') fail('The user must resume paused work before its plan can change.', 403);
    if (linkedActiveTasks(this.store.state, workId).length) fail('Finish or cancel unfinished linked runs before changing the plan.', 409);
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 8) fail('A plan must contain 1–8 steps.');
    const reused = new Set();
    const steps = input.steps.map(entry => {
      inputObject(entry, ['title', 'instructions']);
      const title = text(entry.title, 'Step title', 120);
      const instructions = text(entry.instructions, 'Step instructions', 6000);
      // Identical finished steps keep their identity and observed attempts when a plan is revised.
      const finished = work.plan?.steps.find(step => step.status === 'finished' && !reused.has(step.id)
        && step.title === title && step.instructions === instructions);
      if (finished) { reused.add(finished.id); return structuredClone(finished); }
      return { id: id(), title, instructions, status: 'pending', taskId: null, attemptIds: [], checkpoint: null };
    });
    const now = timestamp();
    const plan = { id: id(), status: 'draft', steps, createdAt: now, updatedAt: now,
      approvedAt: null, approvedPermissionMode: null, autoContinue: false };
    this.store.change(() => {
      if (work.plan) work.planHistory.push(structuredClone(work.plan));
      work.plan = plan; work.updatedAt = now;
      this.store.event('plan', 'Plan drafted for review', work.title, { projectId: work.projectId, workId, planId: plan.id });
    });
    return this.get(workId);
  }

  approvePlan(workId, input) {
    inputObject(input, ['planId', 'reviewed', 'autoContinue']);
    const work = this.get(workId);
    const plan = work.plan;
    if (!plan || typeof input.planId !== 'string' || input.planId !== plan.id) fail('Review the current exact plan before starting it.', 409);
    if (input.reviewed !== true || typeof input.autoContinue !== 'boolean') fail('Plan approval requires explicit review and a boolean auto-continue choice.');
    if (['completed', 'cancelled'].includes(work.status)) fail('Reopen this work before approving its plan.', 409);
    if (linkedActiveTasks(this.store.state, workId).length) fail('Finish or cancel unfinished linked runs before approving the plan.', 409);
    const project = this.project(work.projectId);
    const now = timestamp();
    this.store.change(() => {
      plan.approvedAt = now; plan.approvedPermissionMode = project.permissionMode;
      plan.autoContinue = input.autoContinue; plan.updatedAt = now;
      plan.status = plan.steps.every(step => step.status === 'finished') ? 'needs_review' : 'running';
      work.updatedAt = now;
      this.store.event('plan', 'Plan explicitly reviewed', `${work.title} · ${project.permissionMode}`, { projectId: project.id, workId, planId: plan.id });
    });
    return this.get(workId);
  }

  addNote(workId, input) {
    inputObject(input, ['text']);
    const work = this.get(workId);
    const note = { id: id(), text: text(input.text, 'Progress note', 4000), source: 'external_update', createdAt: timestamp() };
    this.store.change(() => {
      work.notes.push(note); work.updatedAt = note.createdAt;
      this.store.event('work_note', 'External progress update', note.text, { projectId: work.projectId, workId, noteId: note.id });
    });
    return this.get(workId);
  }

  updateWork(workId, input, { actor = 'user' } = {}) {
    inputObject(input, ['status', 'title', 'objective', 'nextAction', 'reviewed', 'completionNote']);
    const work = this.get(workId);
    const patch = {};
    for (const [field, limit] of [['title', 120], ['objective', 4000], ['nextAction', 1000]]) {
      if (field in input) patch[field] = text(input[field], field, limit, { optional: field === 'nextAction' });
    }
    if ('reviewed' in input && typeof input.reviewed !== 'boolean') fail('Review confirmation must be a boolean.');
    if ('status' in input) {
      if (!STATUSES.has(input.status)) fail('Unknown work status.');
      if (actor !== 'user' && !MODEL_STATUSES.has(input.status)) fail('Only the user can pause, cancel, or complete work.', 403);
      patch.status = input.status;
    }
    if (actor !== 'user' && ('reviewed' in input || 'completionNote' in input)) fail('Only the user can record completion review.', 403);
    if ('completionNote' in input) patch.completionNote = text(input.completionNote, 'Completion note', 2000);
    const runs = linkedActiveTasks(this.store.state, workId);
    const definitionChanged = ['title', 'objective'].some(field => field in patch && patch[field] !== work[field]);
    if (runs.length && (definitionChanged || patch.status === 'completed')) {
      fail('Wait for linked runs to finish before changing the definition or completing work.', 409);
    }
    if (runs.length && ['paused', 'cancelled'].includes(patch.status) && runs.some(task => !task.cancelRequested
      && !(patch.status === 'paused' && task.status === 'queued' && task.queueState === 'held'))) {
      fail('Request interruption of the linked runs before pausing or cancelling work.', 409);
    }
    if (patch.status === 'completed') {
      if (input.reviewed !== true || !patch.completionNote) fail('Completion requires explicit review and a nonempty completion note.');
      patch.completedAt = timestamp();
    } else if (patch.status && patch.status !== 'completed') {
      patch.completedAt = null;
    }
    if (!Object.keys(patch).length) return work;
    this.store.change(() => {
      Object.assign(work, patch, { updatedAt: timestamp() });
      this.store.event('work', 'Work updated', `${work.title} · ${work.status}`, { projectId: work.projectId, workId });
      if (patch.status === 'completed') this.store.event('work_review', 'User-reviewed completion', patch.completionNote,
        { projectId: work.projectId, workId, createdAt: patch.completedAt });
    });
    return this.get(workId);
  }
}
