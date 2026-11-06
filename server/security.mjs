import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const REDACTED = '[REDACTED]';
const SECRET_KEY = /(?:api_?key|access_?token|refresh_?token|id_?token|auth_?token|authorization|password|passwd|passphrase|client_?secret|private_?key|secret_?access_?key|access_?key_?id|session_?key|session_?cookie|credentials?|secrets?|token|cookie)$/i;
const ASSIGNMENT_KEY = '(?:[a-z][a-z0-9]*_)*(?:api_?key|access_?token|refresh_?token|id_?token|auth_?token|password|passwd|passphrase|client_?secret|private_?key|secret_?access_?key|access_?key_?id|session_?key|session_?cookie|credential|secret|token)';
const SECRET_ASSIGNMENT = new RegExp(`(?<![a-z0-9_])((?:["']?${ASSIGNMENT_KEY}["']?)\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\[REDACTED\\]|[^\\s,;\\]}]+)`, 'gi');

function redactText(text) {
  return text
    .replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED)
    .replace(/\b(?:sk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16})\b/g, REDACTED)
    .replace(/((?:authorization|proxy-authorization)\s*:\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, `Bearer ${REDACTED}`)
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, (_match, prefix, value) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
      return `${prefix}${quote}${REDACTED}${quote}`;
    })
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
}

/** Return a redacted copy of JSON data. Ordinary prose and token counts remain intact. */
export function redact(value) {
  const seen = new WeakSet();
  function visit(item) {
    if (typeof item === 'string') return redactText(item);
    if (item === null || typeof item !== 'object') return item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    const result = Array.isArray(item)
      ? item.map(visit)
      : Object.fromEntries(Object.entries(item).map(([key, child]) => [
        redactText(key), SECRET_KEY.test(key.replace(/[-\s]/g, '_')) ? REDACTED : visit(child),
      ]));
    seen.delete(item);
    return result;
  }
  return visit(value);
}

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

/** Validate the HTTP boundary before reading a request body or dispatching routes. */
export function validateRequest(req, port) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    fail('Invalid server port.', 500);
  }
  const headers = req.headers ?? {};
  const host = headers.host;
  const origin = headers.origin;
  const allowedHosts = new Set([`localhost:${Number(port)}`, `127.0.0.1:${Number(port)}`, `[::1]:${Number(port)}`]);
  if (typeof host !== 'string' || !allowedHosts.has(host.toLowerCase())) {
    fail('A loopback Host with the configured port is required.', 403);
  }
  // Node may normalize duplicate headers; reject the ambiguity before using them.
  for (const name of ['host', 'origin']) {
    if (Array.isArray(req.rawHeaders)) {
      const count = req.rawHeaders.filter((header, index) => index % 2 === 0 && String(header).toLowerCase() === name).length;
      if (count > 1) fail(`Duplicate ${name} headers are not allowed.`, 403);
    }
  }
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method ?? 'GET').toUpperCase());
  if ((mutating || origin !== undefined) && (typeof origin !== 'string' || origin !== `http://${host.toLowerCase()}`)) {
    fail('A matching same-origin request is required.', 403);
  }
  if (headers['sec-fetch-site'] === 'cross-site') fail('Cross-site requests are not allowed.', 403);
}

const SENSITIVE_SEGMENTS = new Set(['.codex', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.git']);
function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sensitiveRoots() {
  const userHome = homedir();
  return [
    ...[...SENSITIVE_SEGMENTS].map(segment => path.join(userHome, segment)),
    path.join(userHome, '.config', 'gcloud'),
    path.join(userHome, '.config', 'gh'),
    path.join(userHome, '.config', 'op'),
    path.join(userHome, 'Library', 'Keychains'),
    ...(process.env.CODEX_HOME ? [path.resolve(process.env.CODEX_HOME)] : []),
  ];
}

function rejectSensitiveWorkspace(candidate, roots) {
  const normalized = path.resolve(candidate);
  if (normalized === path.parse(normalized).root) fail('The filesystem root cannot be a workspace.');
  const segments = normalized.split(path.sep).map(segment => segment.toLowerCase());
  if (segments.some((segment, index) => SENSITIVE_SEGMENTS.has(segment)
    || (segment === '.config' && ['gcloud', 'gh', 'op'].includes(segments[index + 1]))
    || (segment === 'library' && segments[index + 1] === 'keychains'))) {
    fail('Runtime, authentication, and repository metadata directories cannot be workspaces.');
  }
  if (roots.some(root => isInside(normalized, root))) fail('A runtime or authentication directory cannot be a workspace.');
}

/** Resolve only the selected path; this does not scan or sandbox its descendants. */
export async function normalizeWorkspace(input) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0') || !path.isAbsolute(input)) {
    fail('Workspace must be an absolute directory path.');
  }
  const roots = sensitiveRoots();
  rejectSensitiveWorkspace(input, roots);
  let canonical;
  try {
    canonical = await realpath(input);
    if (!(await stat(canonical)).isDirectory()) fail('Workspace must be an ordinary directory.');
  } catch (error) {
    if (error.statusCode) throw error;
    fail('Workspace must be an existing accessible directory.');
  }
  // Resolve known protected directory aliases, without reading their contents.
  const canonicalRoots = await Promise.all(roots.map(root => realpath(root).catch(() => root)));
  rejectSensitiveWorkspace(canonical, [...roots, ...canonicalRoots]);
  return canonical;
}
