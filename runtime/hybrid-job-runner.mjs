// Internal detached supervisor. No raw stdout/stderr or inherited provider credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runAgent3 } from './hybrid-launcher.mjs';
import { jobDirectory, readJobFile, writeJobFile } from './hybrid-jobs.mjs';
const [root, id] = process.argv.slice(2);
let dir, state, poll, heartbeat, polling = false, writing = Promise.resolve();
const abort = new AbortController();
const stop = () => abort.abort();
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try {
  dir = await jobDirectory(root, id);
  state = await readJobFile(dir, 'state.json', 4096);
  const request = await readJobFile(dir, 'request.json', 8192);
  const checkCancel = async () => {
    if (polling) return;
    polling = true;
    try { await fs.lstat(path.join(dir, 'cancel')); abort.abort(); }
    catch (e) { if (e.code !== 'ENOENT') abort.abort(); }
    finally { polling = false; }
  };
  await checkCancel();
  state = { ...state, state: 'RUNNING', updated_at_ms: Date.now() };
  await writeJobFile(dir, 'state.json', state);
  if (process.connected) process.send({ ready: id });
  poll = setInterval(() => { void checkCancel(); }, 100);
  heartbeat = setInterval(() => {
    writing = writing.then(() => writeJobFile(dir, 'state.json', { ...state, updated_at_ms: Date.now() }));
    writing.catch(stop);
  }, 500);
  const result = await runAgent3({ ...request, signal: abort.signal });
  clearInterval(poll); clearInterval(heartbeat); await writing;
  const completed_at_ms = Date.now();
  await writeJobFile(dir, 'result.json', { completed_at_ms, result });
  await writeJobFile(dir, 'state.json', { ...state, state: result.state, updated_at_ms: completed_at_ms });
} catch {
  clearInterval(poll); clearInterval(heartbeat); abort.abort();
  await writing.catch(() => {});
  if (dir && state) {
    const completed_at_ms = Date.now();
    await writeJobFile(dir, 'result.json', { completed_at_ms, result: { state: 'FAILED', error: { code: 'JOB_SUPERVISOR_FAILED' } } }).catch(() => {});
    await writeJobFile(dir, 'state.json', { ...state, state: 'FAILED', updated_at_ms: completed_at_ms }).catch(() => {});
  }
} finally {
  clearInterval(poll); clearInterval(heartbeat);
  if (process.connected) process.disconnect();
}
