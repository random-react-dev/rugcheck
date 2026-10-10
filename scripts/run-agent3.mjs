#!/usr/bin/env node
import fs from 'node:fs/promises';
import { runAgent3 } from '../runtime/hybrid-launcher.mjs';
import { startAgent3, statusAgent3, resultAgent3, cancelAgent3 } from '../runtime/hybrid-jobs.mjs';
const args = process.argv.slice(2);
let requestedTaskId=null;if(args[0]==='--task-id')requestedTaskId=args.splice(0,2)[1];
const worker = args[0] === '--worker' ? args.splice(0, 2)[1] : 'codex';
if(args[0]==='--task-id')requestedTaskId=args.splice(0,2)[1];
const executableOption = value => worker === 'claude-code' ? { worker, claudePath: value } : { worker, codexPath: value };
const usage = '[--task-id UUID] [--worker codex|claude-code] run-agent3.mjs TASK.json GATEWAY_URL MODEL ABSOLUTE_CODEX_PATH | start JOB_ROOT TASK.json GATEWAY_URL MODEL ABSOLUTE_CODEX_PATH | status|result|cancel JOB_ROOT JOB_ID';
const readTask = async file => {
  let h;
  try {
    h = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = await h.stat(); if (!stat.isFile() || stat.size > 4096) throw new Error();
    const bytes = Buffer.alloc(4097), { bytesRead } = await h.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error(); return JSON.parse(bytes.subarray(0, bytesRead));
  } finally { await h?.close(); }
};
const abort = new AbortController(), stop = () => abort.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  let result;
  if (args[0] === 'start' && args.length === 6) {
    result = await startAgent3({ requestedTaskId, root: args[1], input: await readTask(args[2]), endpoint: args[3], model: args[4], ...executableOption(args[5]) });
  } else if (['status', 'result', 'cancel'].includes(args[0]) && args.length === 3) {
    result = await ({ status: statusAgent3, result: resultAgent3, cancel: cancelAgent3 })[args[0]]({ root: args[1], jobId: args[2] });
  } else if (args.length === 4) {
    result = await runAgent3({ requestedTaskId, input: await readTask(args[0]), endpoint: args[1], model: args[2], ...executableOption(args[3]), signal: abort.signal });
  } else { console.log(JSON.stringify({ state: 'FAILED', error: { code: 'USAGE', usage } })); process.exitCode = 2; }
  if (result) { console.log(JSON.stringify(result)); process.exitCode = ['FAILED', 'CANCELLED', 'STALE'].includes(result.state) || result.error ? 1 : 0; }
} catch {
  console.log(JSON.stringify({ state: 'FAILED', error: { code: args.length === 4 ? 'INVALID_TASK_FILE' : 'JOB_OR_TASK_INVALID' } })); process.exitCode = 2;
} finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
