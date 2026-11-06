import { spawn } from 'node:child_process';
const build=spawn(process.execPath,['node_modules/vite/bin/vite.js','build','--watch'],{stdio:'inherit'});
const server=spawn(process.execPath,['--watch','server/index.mjs'],{stdio:'inherit'});
let stopping=false;
const stop=()=>{if(stopping)return;stopping=true;build.kill('SIGTERM');server.kill('SIGTERM');};
process.on('SIGINT',stop);process.on('SIGTERM',stop);build.on('exit',stop);server.on('exit',stop);
