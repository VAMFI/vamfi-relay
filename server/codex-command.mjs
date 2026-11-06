import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

// Prefer the CLI shipped with the desktop app so its model support stays aligned.
// An explicit override always wins; unsupported installations fall back to PATH.
export async function codexCommand({override=process.env.RELAY_CODEX_BIN,platform=process.platform,executable=async path=>{
  try { await access(path,constants.X_OK); return true; } catch { return false; }
}}={}) {
  if(override?.trim())return override.trim();
  if(platform==='darwin')for(const app of ['ChatGPT','Codex']) {
    const path=`/Applications/${app}.app/Contents/Resources/codex-cli/bin/codex`;
    if(await executable(path))return path;
  }
  return 'codex';
}
