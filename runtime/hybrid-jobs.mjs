import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnvironment, configText } from './hybrid-launcher.mjs';
import { task, gatewayURL, MAX_BODY, validateResult, validateTask } from './hybrid-protocol.mjs';
import { invariant, RugError } from './errors.mjs';

const terminal = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED']);
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const STALE_MS = 5000;
const MAX_FILE = MAX_BODY * 4;

// A dedicated owner-only directory is required. Never chmod an existing user directory.
export async function jobDirectory(root, id) {
  invariant(['linux', 'darwin'].includes(process.platform), 'PLATFORM_UNQUALIFIED');
  invariant(typeof root === 'string' && path.isAbsolute(root) && root === path.resolve(root), 'JOB_ROOT_INVALID');
  if (id !== undefined) invariant(idPattern.test(id), 'JOB_ID_INVALID');
  const check = async p => {
    const s = await fs.lstat(p);
    invariant(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0, 'JOB_DIRECTORY_UNSAFE');
    invariant(await fs.realpath(p) === p, 'JOB_DIRECTORY_UNSAFE');
  };
  await check(root);
  if (id === undefined) return root;
  const dir = path.join(root, id); await check(dir); return dir;
}
export async function readJobFile(dir, name, max = MAX_FILE) {
  let h;
  try {
    h = await fs.open(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    // Atomic replacement may unlink this already-open snapshot (nlink 0).
    const s = await h.stat();
    invariant(s.isFile() && s.nlink <= 1 && s.uid === process.getuid() && (s.mode & 0o077) === 0 && s.size <= max, 'JOB_FILE_UNSAFE');
    const b = Buffer.alloc(max + 1), { bytesRead } = await h.read(b, 0, b.length, 0);
    invariant(bytesRead <= max, 'JOB_FILE_UNSAFE');
    return JSON.parse(b.subarray(0, bytesRead).toString());
  } finally { await h?.close(); }
}
export async function writeJobFile(dir, name, value) {
  const data = JSON.stringify(value); invariant(Buffer.byteLength(data) <= MAX_FILE, 'JOB_OUTPUT_LIMIT');
  const tmp = path.join(dir, '.' + crypto.randomUUID());
  try {
    const h = await fs.open(tmp, 'wx', 0o600);
    try { await h.writeFile(data); await h.sync(); } finally { await h.close(); }
    await fs.rename(tmp, path.join(dir, name));
  } finally { await fs.rm(tmp, { force: true }); }
}
function validateState(s, id) {
  invariant(s?.job_id === id && ['STARTING', 'RUNNING', ...terminal].includes(s.state) &&
    Number.isSafeInteger(s.created_at_ms) && Number.isSafeInteger(s.updated_at_ms) &&
    Number.isInteger(s.timeout_ms) && s.timeout_ms >= 100 && s.timeout_ms <= 120000, 'JOB_STATE_INVALID');
  return s;
}
function summary(s) {
  return { job_id: s.job_id, state: s.state, created_at_ms: s.created_at_ms, updated_at_ms: s.updated_at_ms,
    timeout_ms: s.timeout_ms, ...(s.state === 'STALE' ? { error: { code: 'JOB_STALE_OUTCOME_UNKNOWN' } } : {}) };
}
export async function statusAgent3({ root, jobId }) {
  const dir = await jobDirectory(root, jobId), s = validateState(await readJobFile(dir, 'state.json', 4096), jobId);
  // Do not mutate worker-owned state, infer success, or signal a PID recovered from disk.
  if (!terminal.has(s.state) && (Date.now() - s.updated_at_ms > STALE_MS || Date.now() - s.created_at_ms > s.timeout_ms + STALE_MS)) s.state = 'STALE';
  return summary(s);
}
export async function resultAgent3({ root, jobId }) {
  const status = await statusAgent3({ root, jobId });
  if (!terminal.has(status.state)) return { ...status, result: null };
  const dir = await jobDirectory(root, jobId), saved = await readJobFile(dir, 'result.json');
  invariant(saved?.result?.state === status.state && Number.isSafeInteger(saved.completed_at_ms), 'JOB_RESULT_INVALID');
  const value = saved.result;
  if (['SUCCEEDED', 'PARTIAL'].includes(value.state)) {
    const request = await readJobFile(dir, 'request.json', 8192);
    const input = validateTask({ ...task(request.input), task_id: value.task_id });
    const report = validateResult({ protocol_version: value.protocol_version, task_id: value.task_id, evidence: value.evidence, interpretation: value.interpretation }, input, saved.completed_at_ms);
    let external_inputs;if(value.external_inputs!==undefined){const x=value.external_inputs;invariant(x&&Object.keys(x).sort().join(',')==='applied,diagnosis,executed,files,retained_after_task,task_id'&&x.task_id===value.task_id&&x.executed===false&&x.retained_after_task===false&&Array.isArray(x.files)&&x.files.length<=10,'JOB_RESULT_INVALID');let total=0;for(const f of x.files){invariant(f&&Object.keys(f).sort().join(',')==='name,path,sha256,size'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(f.name)&&!f.name.includes('..')&&/^external-inputs\/[a-f0-9-]{36}-[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(f.path)&&/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.size)&&f.size>0&&f.size<=524288,'JOB_RESULT_INVALID');total+=f.size;}invariant(total<=2097152&&(x.diagnosis===null||(typeof x.diagnosis==='string'&&Buffer.byteLength(x.diagnosis)<=32000)),'JOB_RESULT_INVALID');if(x.applied!==null)invariant(x.applied&&Object.keys(x.applied).sort().join(',')==='global,installation,source'&&['global','override'].includes(x.applied.source)&&Number.isSafeInteger(x.applied.global)&&x.applied.global>0&&Number.isSafeInteger(x.applied.installation)&&x.applied.installation>0,'JOB_RESULT_INVALID');external_inputs=x;}
    return { ...status, completed_at_ms: saved.completed_at_ms, result: { state: value.state,
      protocol_version: value.protocol_version, task_id: value.task_id, evidence: value.evidence, report,
      interpretation: value.interpretation,...(external_inputs?{external_inputs}:{}), worker: request.worker ?? 'codex', qualification: request.worker === 'claude-code' ? 'LOCAL_CLAUDE_AND_LIVE_GATEWAY_NOT_QUALIFIED' : 'LOCAL_CODEX_AND_LIVE_GATEWAY_NOT_QUALIFIED', isolation: request.worker === 'claude-code' ? 'EVIDENCE_TOOL_ONLY_NOT_OS_SANDBOX' : 'READ_ONLY_REQUESTED_NOT_HOST_SECRECY' } };
  }
  invariant(typeof value.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.error.code), 'JOB_RESULT_INVALID');
  let diagnostics;if(value.diagnostics!==undefined){const d=value.diagnostics;invariant(d&&typeof d==='object'&&!Array.isArray(d)&&Object.keys(d).every(k=>['task_id','http_status','operation','turn'].includes(k))&&typeof d.task_id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(d.task_id)&&(!Object.hasOwn(d,'http_status')||(Number.isInteger(d.http_status)&&d.http_status>=100&&d.http_status<=599))&&(!Object.hasOwn(d,'operation')||['turn','read-evidence'].includes(d.operation))&&(!Object.hasOwn(d,'turn')||(Number.isInteger(d.turn)&&d.turn>=0&&d.turn<4)),'JOB_RESULT_INVALID');diagnostics={...d};}
  return { ...status, completed_at_ms: saved.completed_at_ms, result: { state: value.state, error: { code: value.error.code },...(diagnostics?{diagnostics}:{}) } };
}
export async function cancelAgent3({ root, jobId }) {
  const status = await statusAgent3({ root, jobId });
  if (terminal.has(status.state) || status.state === 'STALE') return status;
  const dir = await jobDirectory(root, jobId);
  try { const h = await fs.open(path.join(dir, 'cancel'), 'wx', 0o600); await h.close(); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  // Request acknowledgement is not a claim that the worker has stopped.
  return { ...status, cancellation_requested: true };
}
export async function startAgent3({ root, input, endpoint, model, codexPath, claudePath, worker = 'codex', installationStateRoot, installationIdentity='auto', requestedTaskId=null, timeoutMs = 90000 }) {
  task(input); const identityUrl=gatewayURL(endpoint);invariant(['auto','required','off'].includes(installationIdentity),'INSTALLATION_MODE_INVALID');
  const identify=installationIdentity==='required'||(installationIdentity==='auto'&&identityUrl.hostname==='rugcheck.r95426882.workers.dev'&&identityUrl.pathname==='/v1/rugcheck');
  if(identify)installationStateRoot??=path.join(os.homedir(),'.local/state/rugcheck');
  if(installationStateRoot!==undefined)invariant(typeof installationStateRoot==='string'&&path.isAbsolute(installationStateRoot),'INSTALLATION_STATE_INVALID'); configText(model, 'http://127.0.0.1');
  invariant(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120000, 'DEADLINE_INVALID');
  invariant(['codex', 'claude-code'].includes(worker), 'WORKER_UNSUPPORTED');
  const executable = worker === 'claude-code' ? claudePath : codexPath;
  invariant(typeof executable === 'string' && path.isAbsolute(executable), worker === 'claude-code' ? 'ABSOLUTE_CLAUDE_PATH_REQUIRED' : 'ABSOLUTE_CODEX_PATH_REQUIRED');
  try { await fs.access(executable, fs.constants.X_OK); } catch { throw new RugError('WORKER_EXECUTABLE_UNAVAILABLE'); }
  invariant(typeof root === 'string' && path.isAbsolute(root) && root === path.resolve(root), 'JOB_ROOT_INVALID');
  try { await fs.mkdir(root, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  await jobDirectory(root);
  const id = crypto.randomUUID(), dir = path.join(root, id); await fs.mkdir(dir, { mode: 0o700 });
  await fs.mkdir(path.join(dir, 'tmp'), { mode: 0o700 });
  const now = Date.now();
  const state = { job_id: id, state: 'STARTING', created_at_ms: now, updated_at_ms: now, timeout_ms: timeoutMs };
  await writeJobFile(dir, 'request.json', { input, endpoint, model, worker, installationIdentity,requestedTaskId,...(installationStateRoot?{installationStateRoot}:{}), ...(worker === 'claude-code' ? { claudePath } : { codexPath }), timeoutMs });
  await writeJobFile(dir, 'state.json', state);
  const runner = fileURLToPath(new URL('./hybrid-job-runner.mjs', import.meta.url));
  const child = spawn(process.execPath, [runner, root, id], { detached: true, cwd: dir,
    env: childEnvironment(dir, process.execPath), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ready = await new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish(false), 3000);
    child.once('error', () => finish(false)); child.once('exit', () => finish(false));
    child.once('message', m => finish(m?.ready === id));
  });
  if (child.connected) child.disconnect(); child.unref();
  if (!ready) {
    // A marker safely stops a slow starter; never kill a possibly reused stored PID.
    await cancelAgent3({ root, jobId: id }).catch(() => {});
    return { job_id: id, state: 'STARTING', error: { code: 'JOB_START_UNCONFIRMED' } };
  }
  return statusAgent3({ root, jobId: id });
}
