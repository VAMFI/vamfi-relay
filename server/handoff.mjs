import { createHash } from 'node:crypto';
import { redact } from './security.mjs';

const fields = new Set(['threadId', 'contextHash', 'request', 'reviewed', 'acknowledgeUncertainActivity', 'requestId']);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

/** Copy explicitly reviewed context into owned execution; never mutate the source chat. */
export class HandoffService {
  constructor({ catalog, runtime }) { this.catalog = catalog; this.runtime = runtime; this.pending = new Set(); }

  async continue(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.has(key))) fail('Supply the supported handoff fields.');
    if (input.reviewed !== true || input.acknowledgeUncertainActivity !== true) fail('Review the selected context and acknowledge that another agent may still be working.');
    if (typeof input.threadId !== 'string' || !/^[\w-]{1,160}$/.test(input.threadId)) fail('Choose a valid source chat.');
    if (typeof input.contextHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.contextHash)) fail('Review the exact current context.');
    if (typeof input.requestId !== 'string' || !/^[\w-]{8,100}$/.test(input.requestId)) fail('Supply a valid request ID.');
    if (typeof input.request !== 'string' || !input.request.trim() || input.request.length > 6000 || input.request.includes('\0')) fail('The next request must contain 1–6000 characters.');
    if (redact(input.request) !== input.request) fail('Remove credentials from the request before continuing.');
    const request = input.request.trim();
    const requestHash = createHash('sha256').update(JSON.stringify([input.threadId, input.contextHash, request])).digest('hex');
    const prior = this.runtime.store.state.tasks.find(task => task.handoffRequestId === input.requestId);
    if (prior) {
      if (prior.handoffRequestHash !== requestHash) fail('This request ID was used with different content. Start a new request.', 409);
      return { taskId: prior.id, sourceThreadId: prior.sourceThreadId };
    }
    if (this.pending.has(input.requestId)) fail('This continuation is already being submitted. Wait before retrying.', 409);
    this.pending.add(input.requestId);
    try {
      const detail = await this.catalog.detail(input.threadId);
      if (detail.contextHash !== input.contextHash) fail('The source context changed. Refresh it and review the new preview before continuing.', 409);
      if (typeof detail.contextText !== 'string' || detail.contextText.length > 32000) fail('The source context exceeds the handoff limit.', 409);
      const { thread } = detail;
      const source = { threadId: thread.id, title: thread.title, workspace: thread.workspace, contextHash: detail.contextHash,
        contextText: detail.contextText, requestId: input.requestId, requestHash };
      const text = `Continue selected Codex work in Relay.\nSource chat: ${thread.title}\nProject directory: ${thread.workspace || 'Unassigned — clarify before project execution.'}\n\nMy next request: ${request}`;
      await this.runtime.connect();
      const result = await this.runtime.chat(text, undefined, source);
      return { ...result, sourceThreadId: thread.id };
    } finally { this.pending.delete(input.requestId); }
  }
}
