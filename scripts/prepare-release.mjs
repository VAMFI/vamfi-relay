import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = content => createHash('sha256').update(content).digest('hex');

// Only reviewed source paths enter a public snapshot. Never discover files by
// walking the checkout: ignored data, personal tracking, and Git history stay out.
export const RELEASE_FILES = Object.freeze([
  '.github/workflows/ci.yml', '.gitignore', 'AGENTS.md', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
  'index.html', 'package.json', 'package-lock.json', 'vite.config.js',
  'docs/ARCHITECTURE.md', 'docs/CAPABILITIES.md', 'docs/CONTRACT.md', 'docs/assets/sample-dashboard.jpg',
  'docs/RESEARCH.md', 'docs/ROADMAP.md', 'docs/VERIFICATION.md', 'docs/DAILY-WORK-CONTRACT.md',
  'docs/WORK-V2-CONTRACT.md', 'docs/WORK-V3-CONTRACT.md', 'docs/WORK-V4-CONTRACT.md',
  'scripts/dev.mjs', 'scripts/prepare-release.mjs', 'scripts/relay.mjs',
  'scripts/preview-fixture.mjs', 'scripts/verify-usecase.mjs', 'scripts/verify-daily.mjs',
  'server/adapters/codex.mjs', 'server/backup.mjs', 'server/catalog.mjs',
  'server/codex-command.mjs', 'server/demo.mjs', 'server/handoff.mjs',
  'server/index.mjs', 'server/runtime.mjs', 'server/security.mjs',
  'server/service.mjs', 'server/skills.mjs', 'server/store.mjs', 'server/work.mjs',
  'tests/adapter.test.mjs', 'tests/backup.test.mjs', 'tests/catalog.test.mjs',
  'tests/codex-command.test.mjs', 'tests/fixtures/mock-codex.mjs',
  'tests/handoff.test.mjs', 'tests/http-catalog.test.mjs', 'tests/http.test.mjs',
  'tests/runtime-plan.test.mjs', 'tests/runtime-work.test.mjs', 'tests/runtime.test.mjs',
  'tests/release.test.mjs',
  'tests/security.test.mjs', 'tests/service.test.mjs', 'tests/skills.test.mjs',
  'tests/store-lock.test.mjs', 'tests/work.test.mjs',
  'web/catalog-lib.js', 'web/catalog-lib.test.js', 'web/catalog.css',
  'web/catalog.jsx', 'web/daily-lib.js', 'web/daily-lib.test.js', 'web/daily.jsx', 'web/daily.css',
  'web/lib.js', 'web/lib.test.js', 'web/main.jsx',
  'web/plans.css', 'web/plans.jsx', 'web/styles.css', 'web/work.css',
  'workspace/README.md',
]);

function privacyProblems(path, text) {
  const problems = [];
  // These are release hygiene checks, not a comprehensive secret scanner.
  if (/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//.test(text)) problems.push('personal home path');
  if (/\/var\/folders\//.test(text)) problems.push('machine-specific temporary path');
  if (path.endsWith('.md')) {
    if (/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i.test(text)) problems.push('local record identifier');
    if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(text)) problems.push('email address');
  }
  return problems;
}

export async function collectRelease(sourceRoot = repositoryRoot) {
  const root = await realpath(sourceRoot);
  const files = [];
  for (const path of RELEASE_FILES) {
    const absolute = resolve(root, path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(absolute) !== absolute) {
      throw new Error(`Release source must be an ordinary, unlinked file: ${path}`);
    }
    if (info.size > 4 * 1024 * 1024) throw new Error(`Release source exceeds its size bound: ${path}`);
    const content = await readFile(absolute);
    const issues = privacyProblems(path, content.toString('utf8'));
    if (issues.length) throw new Error(`Review ${path} before export: ${issues.join(', ')}.`);
    files.push({ path, content, sha256: sha256(content), mode: info.mode & 0o111 ? 0o755 : 0o644 });
  }
  // Detect edits that happened during collection. Export exactly the checked bytes.
  for (const file of files) {
    if (sha256(await readFile(resolve(root, file.path))) !== file.sha256) {
      throw new Error(`Source changed during release collection: ${file.path}. Retry after editing stops.`);
    }
  }
  const pkg = JSON.parse(files.find(file => file.path === 'package.json').content.toString('utf8'));
  const records = files.map(({ path, sha256, mode }) => ({ path, sha256, mode }));
  return { root, files, manifest: { format: 1, product: 'Vamfi Relay', version: pkg.version,
    sourceDigest: sha256(JSON.stringify(records)), files: records,
    excluded: ['Git history', 'application data', 'personal agent configuration',
      'internal task tracking', 'local verification artifacts', 'installed dependencies', 'build output'] } };
}

export async function prepareRelease(destination, { sourceRoot = repositoryRoot } = {}) {
  if (!isAbsolute(destination || '')) throw new Error('Supply an absolute destination outside the checkout.');
  const release = await collectRelease(sourceRoot);
  const target = resolve(destination);
  const parent = await realpath(dirname(target));
  if (parent !== dirname(target)) throw new Error('The destination parent must not contain symlinks.');
  const location = relative(release.root, target);
  if (!location || (!location.startsWith(`..${sep}`) && location !== '..' && !isAbsolute(location))) {
    throw new Error('The release destination must be outside the source checkout.');
  }
  // mkdir without recursive or overwrite refuses any pre-existing destination,
  // including a symbolic link. The new directory stays private while reviewed.
  await mkdir(target, { mode: 0o700 });
  for (const { path, content, mode } of release.files) {
    await mkdir(dirname(resolve(target, path)), { recursive: true, mode: 0o755 });
    await writeFile(resolve(target, path), content, { flag: 'wx', mode });
  }
  await writeFile(resolve(target, 'SOURCE-MANIFEST.json'), `${JSON.stringify(release.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  return release.manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1) throw new Error('Usage: node scripts/prepare-release.mjs --check | /absolute/new-release-directory');
    const manifest = args[0] === '--check' ? (await collectRelease()).manifest : await prepareRelease(args[0]);
    console.log(`${args[0] === '--check' ? 'Checked' : 'Exported'} ${manifest.files.length} source files for v${manifest.version}.`);
    console.log(`Source digest: ${manifest.sourceDigest}`);
    if (args[0] !== '--check') console.log('No Git history copied. Review, install, and verify this snapshot before initializing a fresh public repository.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
