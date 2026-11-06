import { createHash } from 'node:crypto';
import { redact } from './security.mjs';

const MAX_BYTES = 48 * 1024;
const REVIEW_WARNING = 'Automated checks cannot establish safety. Review the entire document before saving or enabling it; imports remain inert and disabled by default.';

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
  return { name, description, content, hash: createHash('sha256').update(content, 'utf8').digest('hex'), warnings, blocked };
}
