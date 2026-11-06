import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serviceOptions, inspectService, startService, stopService } from '../server/service.mjs';

const usage = 'Usage: npm run relay -- start [--open] | status | stop [--stop-running] | backup <file> | restore <file>';
const exec = promisify(execFile);

export async function openBrowser(url, { platform = process.platform, launch = exec } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('Only the local Relay URL can be opened.');
  const command = { darwin: '/usr/bin/open', linux: 'xdg-open', win32: 'explorer.exe' }[platform];
  if (!command) throw new Error('No browser opener is configured for this platform.');
  // execFile passes the URL as one argument without a shell.
  // https://nodejs.org/docs/latest-v22.x/api/child_process.html#child_processexecfilefile-args-options-callback
  await launch(command, [url], { timeout: 5000, windowsHide: true, shell: false });
}

export async function runCli(args = process.argv.slice(2), { env = process.env, write = console.log, open = openBrowser } = {}) {
  const [command, ...rest] = args;
  if ((command === '--help' || command === 'help') && !rest.length) { write(usage); return 0; }
  if (!['start', 'status', 'stop', 'backup', 'restore'].includes(command)) throw new Error(usage);
  if ((command === 'start' && (rest.length > 1 || (rest.length && rest[0] !== '--open')))
      || (command === 'status' && rest.length)
      || (command === 'stop' && (rest.length > 1 || (rest.length && rest[0] !== '--stop-running')))
      || (['backup', 'restore'].includes(command) && (rest.length !== 1 || rest[0].startsWith('--')))) throw new Error(usage);
  const options = serviceOptions(env);
  const base = `http://127.0.0.1:${options.port}`;
  if (command === 'start') {
    const result = await startService(options, env);
    write(`Relay ${result.alreadyRunning ? 'is already running' : 'started'} at ${base} (PID ${result.service.pid}).`);
    if (rest[0] === '--open') {
      try { await open(base); }
      catch { write(`Relay is running, but the browser could not be opened. Open ${base} manually.`); }
    }
  } else if (command === 'status') {
    const result = await inspectService(options);
    if (result.state === 'conflict') throw new Error(`Port ${options.port}: ${result.reason}`);
    write(result.state === 'offline' ? `Relay is not running at ${base}.` : result.service.stopping ? `Relay is stopping at ${base}; shutdown is not yet confirmed (PID ${result.service.pid}).` : `Relay is running at ${base} (PID ${result.service.pid}; active tasks: ${result.service.activeTasks ?? 'unknown'}).`);
  } else if (command === 'stop') {
    const result = await stopService(options, { stopRunning: rest[0] === '--stop-running' });
    write(result.state === 'offline' ? 'Relay is already stopped.' : `Relay stopped.${result.replaced ? ' A different instance has since started on the port.' : ''}`);
  } else {
    const { createBackup, restoreBackup } = await import('../server/backup.mjs');
    const result = command === 'backup'
      ? await createBackup({ dataDir: options.dataDir, outputFile: resolve(rest[0]) })
      : await restoreBackup({ dataDir: options.dataDir, inputFile: resolve(rest[0]) });
    write(command === 'backup' ? `Backup saved to ${result.path}.` : `Backup restored into ${result.dataDir}. Start Relay explicitly when ready.`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runCli(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
