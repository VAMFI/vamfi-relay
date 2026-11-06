import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { normalizeWorkspace, redact } from './security.mjs';

export const READONLY_LIMITS = Object.freeze({ fileBytes: 128 * 1024, readTextBytes: 24 * 1024,
  resultBytes: 48 * 1024, searchBytes: 2 * 1024 * 1024, searchFiles: 200,
  entries: 2000, depth: 8, files: 200, matches: 50, pathBytes: 1024, queryChars: 256 });
const pathProperty = { type: 'string', description: 'Relative project path. Use . for the project directory.' };
export const PROJECT_TOOLS = Object.freeze([
  { name: 'list_files', description: 'List permitted project files. No symlinks or sensitive paths. Results are bounded; truncated means more files may exist.',
    inputSchema: { type: 'object', properties: { path: pathProperty, maxDepth: { type: 'integer', minimum: 0, maximum: 8 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false } },
  { name: 'read_file', description: 'Read a permitted UTF-8 project file. Secrets are redacted. Large display text is truncated after checking the full bounded file.',
    inputSchema: { type: 'object', properties: { path: pathProperty }, required: ['path'], additionalProperties: false } },
  { name: 'search_files', description: 'Search literal, case-sensitive text in permitted project files, with relative paths and line numbers. No regular expressions.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 256 }, path: pathProperty, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false } },
]);
const deniedSegments = new Set(['.git', '.relay', 'node_modules', '.codex', '.hermes', '.claude', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config', '.npmrc', '.netrc', '.pypirc', '.gitconfig', '.git-credentials']);
const deniedName = /(?:^\.env|credential|secret|password|passwd|token|keychain|^auth(?:entication)?(?:\.|$)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|\.(?:pem|key|p12|pfx|jks|keystore)$)/i;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const denied = () => Object.assign(new Error('Path is unavailable or denied by the read-only project policy.'), { code: 'PATH_DENIED' });
const invalid = () => Object.assign(new Error('Invalid read-only tool arguments.'), { code: 'INVALID_ARGUMENTS' });
const forbiddenName = name => deniedSegments.has(name.toLowerCase()) || deniedName.test(name);

function relativePath(value, allowRoot = true) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > READONLY_LIMITS.pathBytes
      || /[\x00-\x1f\x7f\\:]/u.test(value) || path.isAbsolute(value)) throw invalid();
  if (value === '.' && allowRoot) return '.';
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw invalid();
  if (parts.some(forbiddenName)) throw denied();
  return value;
}

function argsFor(args, keys) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))) throw invalid();
}

function integer(value, fallback, min, max) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected < min || selected > max) throw invalid();
  return selected;
}

function prefix(text, bytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while ((buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

/** Application-level read policy, not an OS sandbox. The root cannot be changed by tools. */
export async function createReadonlyProject(inputRoot) {
  if (typeof inputRoot !== 'string' || !path.isAbsolute(inputRoot)) throw invalid();
  if (inputRoot.split(path.sep).some(forbiddenName)) throw denied();
  const root = await normalizeWorkspace(inputRoot);
  if (root.split(path.sep).some(forbiddenName)) throw denied();
  if ((await fs.lstat(inputRoot)).isSymbolicLink()) throw denied();
  const rootStat = await fs.lstat(root, { bigint: true });
  async function inspect(relative) {
    const locations = [root];
    if (relative !== '.') for (const part of relative.split('/')) locations.push(path.join(locations.at(-1), part));
    const chain = [];
    for (const [index, location] of locations.entries()) {
      const stat = await fs.lstat(location, { bigint: true });
      if (stat.isSymbolicLink() || (index < locations.length - 1 && !stat.isDirectory())) throw denied();
      if (index === 0 && (!stat.isDirectory() || !sameIdentity(stat, rootStat))) throw denied();
      chain.push({ location, stat });
    }
    if (await fs.realpath(locations.at(-1)) !== locations.at(-1)) throw denied();
    return chain;
  }
  async function recheck(relative, expected) {
    const observed = await inspect(relative);
    if (observed.length !== expected.length || observed.some((entry, i) => !sameIdentity(entry.stat, expected[i].stat))) throw denied();
    return observed.at(-1).stat;
  }
  function regular(stat) {
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(READONLY_LIMITS.fileBytes)) throw denied();
  }
  async function read(relative) {
    const chain = await inspect(relative);
    regular(chain.at(-1).stat);
    const handle = await fs.open(chain.at(-1).location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      regular(before);
      if (!sameVersion(before, chain.at(-1).stat) || !sameVersion(before, await recheck(relative, chain))) throw denied();
      // Allocate a fixed upper bound and detect growth, rather than readFile's unbounded allocation.
      const buffer = Buffer.alloc(READONLY_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      regular(after);
      if (length > READONLY_LIMITS.fileBytes || BigInt(length) !== after.size || !sameVersion(before, after)
          || !sameVersion(after, await recheck(relative, chain))) throw denied();
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); } catch { throw denied(); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw denied();
      return { text: redact(text, { preserveLines: true }), bytes: length };
    } finally { await handle.close(); }
  }
  async function walk(relative, maxDepth, limit) {
    const files = [], directories = [];
    let entries = 0, truncated = false;
    async function visit(current, depth) {
      const chain = await inspect(current);
      if (!chain.at(-1).stat.isDirectory()) throw denied();
      const dir = await fs.opendir(chain.at(-1).location, { bufferSize: 32 });
      const children = [];
      try {
        for await (const child of dir) {
          if (++entries > READONLY_LIMITS.entries) { truncated = true; break; }
          children.push(child.name);
        }
      } finally { await dir.close().catch(error => { if (error.code !== 'ERR_DIR_CLOSED') throw error; }); }
      await recheck(current, chain);
      directories.push({ relative: current, chain });
      for (const name of children.sort()) {
        const child = current === '.' ? name : `${current}/${name}`;
        let observed;
        try { relativePath(child); observed = await inspect(child); } catch { continue; }
        const stat = observed.at(-1).stat;
        if (stat.isDirectory()) {
          if (depth < maxDepth && entries <= READONLY_LIMITS.entries) await visit(child, depth + 1);
          else truncated = true;
        } else {
          try { regular(stat); } catch { continue; }
          if (files.length >= limit) { truncated = true; break; }
          files.push({ path: child, size: Number(stat.size) });
        }
        if (files.length >= limit) { truncated = true; break; }
      }
    }
    await visit(relative, 0);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { files, truncated, async validate() { for (const dir of directories) await recheck(dir.relative, dir.chain); } };
  }
  function bounded(result, key) {
    const safe = redact(result);
    while (Buffer.byteLength(JSON.stringify(safe)) > READONLY_LIMITS.resultBytes && safe[key].length) {
      safe[key].pop(); safe.truncated = true;
    }
    return safe;
  }
  return Object.freeze({ async call(name, args = {}) {
    try {
      if (name === 'read_file') {
        argsFor(args, ['path']);
        const relative = relativePath(args.path, false);
        const { text } = await read(relative);
        let display = prefix(text, READONLY_LIMITS.readTextBytes);
        const result = { path: redact(relative), text: display, truncated: display !== text };
        // MCP wraps this JSON in a text string. Leave room for a second escaping pass.
        const limit = Math.min(READONLY_LIMITS.resultBytes, 30 * 1024);
        const excess = Buffer.byteLength(JSON.stringify(result)) - limit;
        if (excess > 0) {
          display = prefix(display, Math.max(0, Buffer.byteLength(display) - excess));
          result.text = display; result.truncated = true;
        }
        return result;
      }
      if (name === 'list_files') {
        argsFor(args, ['path', 'maxDepth', 'limit']);
        const result = await walk(relativePath(args.path ?? '.'), integer(args.maxDepth, 4, 0, READONLY_LIMITS.depth), integer(args.limit, 200, 1, READONLY_LIMITS.files));
        await result.validate();
        return bounded({ files: result.files, truncated: result.truncated }, 'files');
      }
      if (name === 'search_files') {
        argsFor(args, ['path', 'query', 'limit']);
        if (typeof args.query !== 'string' || !args.query.length || args.query.length > READONLY_LIMITS.queryChars || /[\x00-\x1f\x7f]/u.test(args.query)) throw invalid();
        const limit = integer(args.limit, 50, 1, READONLY_LIMITS.matches);
        const found = await walk(relativePath(args.path ?? '.'), READONLY_LIMITS.depth, READONLY_LIMITS.searchFiles);
        const matches = [];
        let bytes = 0, filesSearched = 0, truncated = found.truncated;
        for (const file of found.files) {
          if (bytes + file.size > READONLY_LIMITS.searchBytes) { truncated = true; break; }
          let content;
          // Charge the maximum possible read before it starts, including denied binary files.
          if (bytes + READONLY_LIMITS.fileBytes > READONLY_LIMITS.searchBytes) { truncated = true; break; }
          bytes += READONLY_LIMITS.fileBytes;
          try { content = await read(file.path); } catch { continue; }
          bytes -= READONLY_LIMITS.fileBytes - content.bytes;
          filesSearched++;
          for (const [index, line] of content.text.split(/\r?\n/).entries()) {
            if (!line.includes(args.query)) continue;
            matches.push({ path: file.path, line: index + 1, text: prefix(line, 1024) });
            if (matches.length >= limit) { truncated = true; break; }
          }
          if (matches.length >= limit) break;
        }
        await found.validate();
        return bounded({ matches, filesSearched, truncated }, 'matches');
      }
      throw invalid();
    } catch (error) {
      if (error.code === 'INVALID_ARGUMENTS' || error.code === 'PATH_DENIED') throw error;
      throw denied();
    }
  } });
}
