import test from 'node:test';
import assert from 'node:assert/strict';
import { codexCommand } from '../server/codex-command.mjs';

test('explicit Codex executable wins without inspecting app paths',async()=>{
  assert.equal(await codexCommand({override:'/custom/codex',platform:'darwin',executable:()=>{throw new Error('must not inspect');}}),'/custom/codex');
});
test('macOS prefers an executable bundled CLI and other installations use PATH',async()=>{
  const path='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
  assert.equal(await codexCommand({override:'',platform:'darwin',executable:async value=>value===path}),path);
  assert.equal(await codexCommand({override:'',platform:'darwin',executable:async()=>false}),'codex');
  assert.equal(await codexCommand({override:'',platform:'linux',executable:()=>{throw new Error('must not inspect');}}),'codex');
});
