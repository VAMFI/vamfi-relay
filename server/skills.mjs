import { createHash, randomUUID } from 'node:crypto';
import { redact } from './security.mjs';

const MAX_BYTES = 48 * 1024;
const REVIEW_WARNING = 'Automated checks cannot establish safety. Review the entire document before saving or enabling it; imports remain inert and disabled by default.';
const MAX_HISTORY = 20;
const hashContent = content => createHash('sha256').update(content, 'utf8').digest('hex');

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function scalar(value, field) {
  let parsed = value.trim();
  if (/^[>|!&*\[{]/.test(parsed)) fail(`${field} must be a simple text value.`);
  if (parsed.startsWith('"')) {
    try { parsed = JSON.parse(parsed); } catch { fail(`${field} has invalid quoting.`); }
  } else if (parsed.startsWith("'")) {
    if (!parsed.endsWith("'") || parsed.length < 2) fail(`${field} has invalid quoting.`);
    parsed = parsed.slice(1, -1).replace(/''/g, "'");
  }
  if (typeof parsed !== 'string' || !parsed.trim() || /[\u0000-\u001f]/.test(parsed)) fail(`${field} must be nonempty text.`);
  return parsed.trim();
}

/** Inspect a bounded Markdown string only. Never follow references or execute code. */
export function previewSkill(content) {
  if (typeof content !== 'string') fail('Supply Markdown content as text; file, script, and archive imports are unsupported.');
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) fail('Skill content exceeds the 48 KiB limit.', 413);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(content)) fail('Skill content must be plain Markdown text.');
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) fail('Skill Markdown requires frontmatter with name and description.');
  const metadata = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const entry = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!entry) fail('Frontmatter supports simple name and description text fields only.');
    if (metadata.has(entry[1])) fail(`Duplicate frontmatter field: ${entry[1]}.`);
    metadata.set(entry[1], entry[2]);
  }
  if (!metadata.has('name') || !metadata.has('description')) fail('Skill frontmatter requires name and description.');
  const name = scalar(metadata.get('name'), 'name');
  const description = scalar(metadata.get('description'), 'description');
  if (name.length > 100 || description.length > 1000) fail('Skill name or description is too long.');

  const warnings = [REVIEW_WARNING];
  let blocked = false;
  const block = warning => { blocked = true; warnings.push(warning); };
  if (redact(content) !== content) block('Recognizable credential or private-key content was detected. Remove secrets before importing.');
  const importFields = [...metadata.keys()].filter(key => /^(?:scripts?|archives?|imports?|paths?|files?|source|command|entrypoint)$/i.test(key));
  const importInstruction = /\b(?:import|load|source|execute|run|fetch|download|install|unpack|extract)\b[^\n]{0,160}(?:\.(?:[cm]?js|jsx|tsx?|py|sh|bash|zsh|ps1|exe|dll|so|dylib|zip|tar(?:\.gz)?|tgz|gz|7z|rar|wasm)\b|\|\s*(?:ba|z)?sh\b)/i;
  if (importFields.length || importInstruction.test(content)) block('Script, archive, or file import instructions are unsupported. Only this Markdown document can be imported.');
  const escalation = /(?:\bsudo\s+\S|\bsu\s+(?:-\s*)?root\b|\bchmod\s+(?:u\+s|\+s|[2467][0-7]{3})\b|--dangerously-bypass-approvals-and-sandbox|\b(?:disable|bypass|ignore|override)\b[^\n.]{0,80}\b(?:approvals?|sandbox|permission checks|security controls)\b|\b(?:request|obtain|use|gain|enable)\b[^\n.]{0,60}\b(?:root|administrator|elevated)\s+(?:access|permissions?|privileges?)\b|\belevate\s+(?:your\s+)?privileges\b)/i;
  if (escalation.test(content)) block('Instructions to escalate privileges or bypass permission boundaries are unsupported.');
  if (/\b(?:ignore|disregard)\b[^\n.]{0,60}\b(?:previous|prior|system|developer)\s+instructions\b/i.test(content)) {
    warnings.push('The document contains an instruction-override pattern. Review it as untrusted content.');
  }
  return { name, description, content, hash: hashContent(content), warnings, blocked };
}

function reviewedDocument(input, revision = false) {
  const fields = revision ? ['content', 'hash', 'reviewed', 'expectedHash'] : ['content', 'hash', 'reviewed'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail('Supply the supported skill review fields.');
  const preview = previewSkill(input.content);
  if (input.reviewed !== true || preview.hash !== input.hash) fail('Review this exact document before importing it.');
  if (preview.blocked) fail('This document contains blocked content. Remove it before importing.');
  return preview;
}

function revisionSnapshot(skill) {
  const hash = hashContent(skill.content);
  return { id: skill.id, name: skill.name, description: skill.description, content: skill.content, hash,
    revision: Number.isInteger(skill.revision) && skill.revision > 0 ? skill.revision : 1,
    revisionId: skill.revisionId || `legacy-${hashContent(JSON.stringify([skill.id, hash])).slice(0, 32)}`,
    createdAt: skill.revisionCreatedAt || skill.createdAt,
    revisionCreatedAt: skill.revisionCreatedAt || skill.createdAt,
    reviewedAt: skill.reviewedAt || skill.createdAt,
    warnings: [...(skill.warnings || [])], blocked: Boolean(skill.blocked) };
}

/** A reviewed document is inert until separately enabled and selected for a request. */
export function createReviewedSkill(input) {
  const preview = reviewedDocument(input);
  const now = new Date().toISOString();
  return { id: randomUUID(), ...preview, enabled: false, createdAt: now,
    revision: 1, revisionId: randomUUID(), revisionCreatedAt: now, reviewedAt: now, history: [] };
}

/** Preserve previous reviewed bytes rather than rewriting historical request evidence. */
export function reviseReviewedSkill(skill, input) {
  const preview = reviewedDocument(input, true);
  const previous = revisionSnapshot(skill);
  if (input.expectedHash !== previous.hash) fail('The skill changed. Reload it before reviewing a new revision.', 409);
  if (preview.name !== skill.name) fail('A revision must keep the existing skill name. Import a different skill to use a new name.', 409);
  if (preview.hash === previous.hash) fail('This exact revision is already saved.', 409);
  if ((skill.history?.length || 0) >= MAX_HISTORY) fail('This skill has reached its 20-revision history limit. Previous request evidence will not be discarded.', 409);
  const now = new Date().toISOString();
  return { ...skill, ...preview, enabled: false, revision: previous.revision + 1,
    revisionId: randomUUID(), revisionCreatedAt: now, reviewedAt: now, updatedAt: now,
    history: [...structuredClone(skill.history || []), previous] };
}

/** Snapshot before asynchronous session startup. The receipt hashes exact document
 * bytes injected as content, excluding the surrounding untrusted-context wrapper.
 */
export function snapshotSelectedSkills(skills, skillIds, provider, skillSelections) {
  if (skillIds !== undefined && (!Array.isArray(skillIds) || skillIds.length > 20
    || skillIds.some(id => typeof id !== 'string' || !id || id.length > 160))) fail('Select at most 20 valid skill identifiers.');
  let expected;
  if (skillSelections !== undefined) {
    if (!Array.isArray(skillSelections) || skillSelections.length > 20 || skillSelections.some(selection =>
      !selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).some(key => !['id', 'hash', 'revisionId'].includes(key))
      || typeof selection.id !== 'string' || !selection.id || selection.id.length > 160
      || typeof selection.hash !== 'string' || !/^[a-f0-9]{64}$/.test(selection.hash)
      || ('revisionId' in selection && (typeof selection.revisionId !== 'string' || !selection.revisionId || selection.revisionId.length > 160)))) {
      fail('Supply exact skill selections with an identifier, hash, and optional revision identifier.');
    }
    expected = new Map(skillSelections.map(selection => [selection.id, selection]));
    if (expected.size !== skillSelections.length) fail('Each selected skill may appear only once.');
    if (skillIds !== undefined && (new Set(skillIds).size !== expected.size || skillIds.some(id => !expected.has(id)))) {
      fail('Skill identifiers and reviewed selections must refer to the same skills.');
    }
    skillIds = [...expected.keys()];
  }
  if (skillIds?.length && provider !== 'codex') fail('Selected skill documents are supported only by the Codex master conversation.');
  const selected = skills.filter(skill => skill.enabled && skillIds?.includes(skill.id));
  if (expected && selected.length !== expected.size) fail('A selected skill is missing or disabled. Refresh and select it again before sending.', 409);
  const documents = []; const receipts = [];
  for (const skill of selected) {
    if (typeof skill.content !== 'string' || Buffer.byteLength(skill.content, 'utf8') > MAX_BYTES
      || skill.blocked || redact(skill.content) !== skill.content) fail('A selected skill is no longer valid. Review it again before sending.', 409);
    const revision = revisionSnapshot(skill);
    if (skill.hash && skill.hash !== revision.hash) fail('A selected skill changed outside its review. Review it again before sending.', 409);
    const selection = expected?.get(skill.id);
    if (selection && (selection.hash !== revision.hash || (selection.revisionId !== undefined && selection.revisionId !== revision.revisionId))) {
      fail('A selected skill revision changed. Review and select the current revision before sending.', 409);
    }
    documents.push({ name: skill.name, content: skill.content });
    receipts.push({ id: skill.id, name: skill.name, revisionId: revision.revisionId,
      revision: revision.revision, hash: revision.hash });
  }
  return { documents, receipts };
}
