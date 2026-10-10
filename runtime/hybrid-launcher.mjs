import {createLocalInstallation} from './installation-client.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { claudeEnvironment, claudeArguments, normalizeClaudeRequest, sendClaudeResponse, parseClaudeOutput } from './hybrid-claude.mjs';
import { interpretationSchema } from './schema.mjs';
import { canonical } from './core.mjs';
import { RugError, invariant, publicError } from './errors.mjs';
import { task, validateTask, validateResult, readBounded, gatewayURL, MAX_BODY, PROTOCOL, EVIDENCE_TOOL, decodeToolOutput, validateToolOutput } from './hybrid-protocol.mjs';

export function childEnvironment(home, executable, source = process.env) {
  // Deliberately exclude provider credentials, proxies, NODE_OPTIONS, shell hooks and user config.
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex'),
    TMPDIR: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'),
    PATH: [path.dirname(executable), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), LANG: 'C.UTF-8' };
  if (process.platform === 'win32' && source.SystemRoot) env.SystemRoot = source.SystemRoot;
  return env;
}
export function configText(model, baseURL) {
  invariant(typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(model), 'MODEL_INVALID');
  return `model = ${JSON.stringify(model)}\nmodel_provider = "rugcheck"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\ntool_output_token_limit = 32768\n[model_providers.rugcheck]\nname = "RugCheck task gateway"\nbase_url = ${JSON.stringify(baseURL)}\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 15000\n`;
}
function sendResponse(res, response, model, streaming) {
  const { id, output } = response, item = output[0], text = item.content?.[0]?.text;
  const isTool = item.type === 'function_call';
  const completed = { id, object: 'response', created_at: Math.floor(Date.now()/1000), status: 'completed', model, output: [item], error: null, incomplete_details: null, usage: null };
  if (!streaming) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(completed)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  let sequence_number = 0;
  const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...fields })}\n\n`);
  event('response.created', { response: { ...completed, status: 'in_progress', output: [], usage: null } });
  event('response.output_item.added', { output_index: 0, item: isTool ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', content: [] } });
  if (isTool) {
    event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
    event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
  event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
  event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
  event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  }
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', { response: completed }); res.end();
}
const closedChildren = new WeakSet();
function killGroup(child, signal) {
  // Never signal a group through a handle whose complete close was already observed.
  if (!child?.pid || closedChildren.has(child)) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') { try { child.kill(signal); } catch {} } }
}
async function safeOutput(file) {
  let handle;
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = await handle.stat();
    invariant(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_BODY, 'WORKER_OUTPUT_INVALID');
    const bytes = Buffer.alloc(MAX_BODY + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    invariant(bytesRead <= MAX_BODY, 'WORKER_OUTPUT_INVALID');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } catch { throw new RugError('WORKER_OUTPUT_INVALID'); }
  finally { await handle?.close(); }
}
/** Async, bounded, one-shot worker. Never changes the user's normal Codex home. */
export async function runAgent3({ input, reservedTask, gatewayHeaders = {}, endpoint, model, codexPath, claudePath, worker = 'codex', installationStateRoot, installationIdentity='auto', signal, timeoutMs = 90000, onEvent = () => {} }) {
  let home, relay, child, killTimer, timer, childClosed;
  const controller = new AbortController();
  const abort = () => controller.abort(new RugError('CANCELLED'));
  const emit = (code, fields = {}) => { try { onEvent({ event: code, ...fields }); } catch {} };
  let accepted = 0, result, report, fault, taskId, rejection;
  try {
    invariant(['linux', 'darwin'].includes(process.platform), 'PLATFORM_UNQUALIFIED');
    invariant(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120000, 'DEADLINE_INVALID');
    invariant(['codex', 'claude-code'].includes(worker), 'WORKER_UNSUPPORTED');
    const executable = worker === 'claude-code' ? claudePath : codexPath;
    invariant(typeof executable === 'string' && path.isAbsolute(executable), worker === 'claude-code' ? 'ABSOLUTE_CLAUDE_PATH_REQUIRED' : 'ABSOLUTE_CODEX_PATH_REQUIRED');
    try { await fs.access(executable, fs.constants.X_OK); } catch { throw new RugError('WORKER_EXECUTABLE_UNAVAILABLE'); }
    invariant(gatewayHeaders && typeof gatewayHeaders==='object' && !Array.isArray(gatewayHeaders) && Object.keys(gatewayHeaders).every(k=>k==='authorization') && Object.values(gatewayHeaders).every(v=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\r\n]/.test(v)),'GATEWAY_AUTH_INVALID');
    const url = gatewayURL(endpoint), inputTask = reservedTask ? validateTask(structuredClone(reservedTask)) : task(input);
    taskId=inputTask.task_id;
    invariant(canonical(inputTask.request)===canonical(input),'RESERVED_TASK_CHANGED');
    configText(model, 'http://127.0.0.1');
    if (signal?.aborted) throw new RugError('CANCELLED');
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => controller.abort(new RugError('DEADLINE_EXCEEDED')), timeoutMs);
    invariant(['auto','required','off'].includes(installationIdentity),'INSTALLATION_MODE_INVALID');
    const identify=installationIdentity==='required'||(installationIdentity==='auto'&&url.hostname==='rugcheck.r95426882.workers.dev'&&url.pathname==='/v1/rugcheck');
    const installation=identify?await createLocalInstallation({...(installationStateRoot?{root:installationStateRoot}:{})}):null;
    if(installation){const enrollment={public_key:installation.public_key};const registered=await fetch(new URL('/v1/installations',url),{method:'POST',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]),headers:{'content-type':'application/json',...installation.headers('/v1/installations',enrollment)},body:JSON.stringify(enrollment)});let value;try{value=JSON.parse(await readBounded(registered.body,4096));}catch{}invariant(registered.ok&&value?.installation_id===installation.id,'INSTALLATION_ENROLLMENT_FAILED');}
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'rugcheck-agent3-'));
    await fs.chmod(home, 0o700);
    for (const dir of ['codex', 'claude', 'tmp', 'work']) await fs.mkdir(path.join(home, dir), { mode: 0o700 });
    const token = crypto.randomBytes(24).toString('hex');
    let turn = 0, previous = null, pending = [], localEvidence = null;
    const sent = new Map(); let relayBusy = false;
    const gateway = async body => {
      for (let attempt = 0; attempt < 3; attempt++) {
        emit('GATEWAY_REQUEST', { operation: body.operation, turn: body.turn, attempt });
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', ...gatewayHeaders, ...(installation?installation.headers('/v1/rugcheck',body):{}) }, body: JSON.stringify(body) });
        if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
          await response.body?.cancel(); emit('GATEWAY_RETRY');
          await delay(100 * 2 ** attempt, undefined, { signal: controller.signal }); continue;
        }
        if (!response.ok) {
          let failure;
          try { failure=JSON.parse(await readBounded(response.body,4096)); } catch {}
          const code=typeof failure?.error?.code==='string' && /^SERVER_[A-Z_]{1,70}$/.test(failure.error.code) ? failure.error.code : 'GATEWAY_HTTP_ERROR';
          rejection={http_status:response.status,operation:body.operation,...(Number.isInteger(body.turn)?{turn:body.turn}:{})};
          emit('GATEWAY_REJECTED', { task_id:taskId, ...rejection, code });
          throw new RugError(code);
        }
        emit('GATEWAY_RESPONSE', { http_status: response.status, operation: body.operation, turn: body.turn });
        return JSON.parse(await readBounded(response.body));
      }
    };
    relay = http.createServer(async (req, res) => {
      const disconnected = () => { if (!res.writableFinished && !controller.signal.aborted) controller.abort(new RugError('WORKER_CONNECTION_CLOSED')); };
      req.once('aborted', disconnected); res.once('close', disconnected);
      try {
        const route = worker === 'claude-code' && req.url === `/${token}/v1/messages?beta=true` ? `/${token}/v1/messages` : req.url;
        invariant(req.method === 'POST' && [`/${token}/v1/${worker === 'claude-code' ? 'messages' : 'responses'}`, `/${token}/evidence`].includes(route), 'ROUTE_DENIED');
        invariant(++accepted <= 12, 'REQUEST_LIMIT');
        let incoming = JSON.parse(await readBounded(req, MAX_BODY));
        if (req.url.endsWith('/evidence')) {
          invariant(pending.length === 1 && incoming && Object.keys(incoming).length === 0, 'LOCAL_TOOL_DENIED');
          localEvidence ??= gateway({ task: inputTask, operation: 'read-evidence' });
          const value = await localEvidence;
          validateToolOutput(value, value.evidence, inputTask);
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); return;
        }
        if (worker === 'claude-code') {
          invariant(req.headers['x-api-key'] === token, 'LOCAL_AUTH_INVALID');
          incoming = normalizeClaudeRequest(incoming);
        }
        let namespaced = false;
        const respond = worker === 'claude-code' ? sendClaudeResponse : (res, response, model, streaming) => sendResponse(res, { ...response, output: response.output.map(item => namespaced && item.type === 'function_call' ? { ...item, name: 'read_evidence', namespace: 'mcp__rugcheck' } : item) }, model, streaming);
        invariant(incoming && typeof incoming === 'object' && incoming.model === model && typeof incoming.stream === 'boolean', 'PROVIDER_REQUEST_INVALID');
        const namespace = incoming.tools?.find(t => t.type === 'namespace' && t.name === 'mcp__rugcheck');
        const namespacedTool = namespace?.tools?.find(t => t.type === 'function' && t.name === 'read_evidence');
        namespaced = Boolean(namespacedTool);
        const fixedTool = incoming.tools?.find(t => t.type === 'function' && t.name === EVIDENCE_TOOL.name) ?? namespacedTool;
        invariant(fixedTool && fixedTool.parameters?.type === 'object' &&
          Object.keys(fixedTool.parameters.properties ?? {}).length === 0 &&
          (fixedTool.parameters.required ?? []).length === 0, 'CODEX_EVIDENCE_TOOL_MISSING');
        // Other advertised tools and all client instructions/transcript text are discarded, never sent upstream.
        const requestKey = crypto.createHash('sha256').update(canonical(incoming)).digest('hex');
        if (sent.has(requestKey)) { respond(res, sent.get(requestKey), model, incoming.stream); return; }
        invariant(!relayBusy && turn < 4, 'CONTINUATION_LIMIT'); relayBusy = true;
        try {
          const outputs = (Array.isArray(incoming.input) ? incoming.input : []).filter(i => i.type === 'function_call_output');
          const relevant = outputs.filter(i => pending.some(c => c.call_id === i.call_id));
          invariant(relevant.length === pending.length, 'CONTINUATION_CALL_MISSING');
          invariant(outputs.every(i => pending.some(c => c.call_id === i.call_id) || sent.has('call:' + i.call_id)), 'CONTINUATION_CALL_UNKNOWN');
          const tool_outputs = [];
          for (const output of relevant) {
            invariant(localEvidence, 'LOCAL_TOOL_NOT_USED'); const evidenceResult = await localEvidence;
            emit('TOOL_OUTPUT_FORMAT', { bytes: Buffer.byteLength(JSON.stringify(output.output)), truncation_notice: typeof output.output==='string' && /truncated output|tokens truncated|chars truncated/.test(output.output) });
            const parsed = decodeToolOutput(output.output); validateToolOutput(parsed, evidenceResult.evidence, inputTask);
            tool_outputs.push({ call_id: output.call_id, output: parsed });
          }
          const value = await gateway({ task: inputTask, operation: 'turn', turn, previous_response_id: previous, tool_outputs });
          invariant(value && Object.keys(value).sort().join(',') === 'evidence,interpretation,protocol_version,response,task_id' &&
            value.protocol_version === PROTOCOL && value.task_id === inputTask.task_id &&
            value.response && Object.keys(value.response).sort().join(',') === 'id,output' &&
            typeof value.response.id === 'string' && /^resp_[a-f0-9-]{36}$/.test(value.response.id) &&
            Array.isArray(value.response.output) && value.response.output.length === 1, 'GATEWAY_RESPONSE_INVALID');
          const item = value.response.output[0];
          if (item.type === 'function_call') {
            invariant(value.evidence === null && value.interpretation === null && turn < 2 &&
              Object.keys(item).sort().join(',') === 'arguments,call_id,id,name,status,type' && item.name === EVIDENCE_TOOL.name && item.arguments === '{}' &&
              item.status === 'completed' && /^fc_[a-f0-9-]{36}$/.test(item.id) && /^[a-zA-Z0-9_-]{1,100}$/.test(item.call_id), 'GATEWAY_TOOL_DENIED');
            pending = [item];
          } else {
            const validated = { protocol_version: value.protocol_version, task_id: value.task_id, evidence: value.evidence, interpretation: value.interpretation };
            report = validateResult(validated, inputTask);
            invariant(Object.keys(item).sort().join(',') === 'content,id,role,status,type' && item.type === 'message' && item.role === 'assistant' &&
              item.status === 'completed' && /^msg_[a-f0-9-]{36}$/.test(item.id) &&
              canonical(item.content) === canonical([{ type: 'output_text', text: JSON.stringify(value.interpretation), annotations: [] }]), 'GATEWAY_MESSAGE_INVALID');
            result = validated; pending = [];
          }
          for (const output of relevant) sent.set('call:' + output.call_id, true);
          turn++; previous = value.response.id; sent.set(requestKey, value.response);
          respond(res, value.response, model, incoming.stream);
        } finally { relayBusy = false; }
      } catch (error) {
        fault ??= error instanceof RugError ? error : new RugError('GATEWAY_PROTOCOL_ERROR');
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        if (!res.destroyed) res.end(JSON.stringify({ error: { code: publicError(fault).code } }));
        // A terminal relay fault must stop the CLI immediately. Claude retries 502
        // responses internally; waiting for process exit concealed the real fault.
        emit('RELAY_FAILED', { code: publicError(fault).code });
        if (!controller.signal.aborted) controller.abort(fault);
      } finally { req.removeListener('aborted', disconnected); res.removeListener('close', disconnected); }
    });
    relay.requestTimeout = Math.min(timeoutMs, 30000); relay.headersTimeout = Math.min(timeoutMs, 10000);
    await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${relay.address().port}/${token}/v1`;
    const mcpScript = fileURLToPath(new URL('./hybrid-evidence-mcp.mjs', import.meta.url));
    const mcp = `\n[mcp_servers.rugcheck]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([mcpScript, `http://127.0.0.1:${relay.address().port}/${token}/evidence`])}\nstartup_timeout_sec = 10\ntool_timeout_sec = 20\nrequired = true\nenabled_tools = ["read_evidence"]\n`;
    await fs.writeFile(path.join(home, 'codex/config.toml'), configText(model, base) + mcp, { mode: 0o600 });
    const schemaFile = path.join(home, 'schema.json'), outputFile = path.join(home, 'result.json');
    await fs.writeFile(schemaFile, JSON.stringify(interpretationSchema), { mode: 0o600 });
    if (controller.signal.aborted) throw controller.signal.reason;
    const mcpFile = path.join(home, 'mcp.json');
    await fs.writeFile(mcpFile, JSON.stringify({ mcpServers: { rugcheck: { command: process.execPath, args: [mcpScript, `http://127.0.0.1:${relay.address().port}/${token}/evidence`] } } }), { mode: 0o600 });
    const args = worker === 'claude-code' ? claudeArguments(model, mcpFile) : ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--json', '--output-schema', schemaFile, '--output-last-message', outputFile, '--cd', path.join(home, 'work'), '-'];
    child = spawn(executable, args, { cwd: path.join(home, 'work'), detached: true, env: { ...childEnvironment(home, executable), ...(worker === 'claude-code' ? claudeEnvironment(home, base.replace(/\/v1$/, ''), token, model) : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    childClosed = new Promise(resolve => { child.once('error', () => resolve({ error: true })); child.once('close', code => { closedChildren.add(child); resolve({ code }); }); });
    const stop = () => { killGroup(child, 'SIGTERM'); killTimer ??= setTimeout(() => killGroup(child, 'SIGKILL'), 300); };
    controller.signal.addEventListener('abort', stop, { once: true });
    let streamed = 0; const stdout = [];
    const drain = chunk => { streamed += chunk.length; if (streamed > 1024 * 1024 && !controller.signal.aborted) controller.abort(new RugError('WORKER_OUTPUT_LIMIT')); };
    child.stdout.on('data', chunk => { drain(chunk); if (worker === 'claude-code' && streamed <= 1024 * 1024) stdout.push(chunk); }); child.stderr.on('data', drain);
    child.stdin.on('error', () => { if (!controller.signal.aborted) controller.abort(new RugError('WORKER_STDIN_FAILED')); });
    child.stdin.end(JSON.stringify(inputTask)); emit('WORKER_STARTED');
    const finished = await childClosed;
    if (controller.signal.aborted) throw controller.signal.reason;
    invariant(!finished.error, 'WORKER_START_FAILED');
    if (fault) throw fault;
    invariant(finished.code === 0, 'WORKER_EXIT_FAILED');
    invariant(result && report, 'GATEWAY_NOT_USED');
    const output = worker === 'claude-code' ? parseClaudeOutput(Buffer.concat(stdout).toString('utf8')) : await safeOutput(outputFile);
    if (controller.signal.aborted) throw controller.signal.reason;
    invariant(canonical(output) === canonical(result.interpretation), 'WORKER_RESULT_CHANGED');
    emit('WORKER_COMPLETED');
    return { state: report.status === 'complete' ? 'SUCCEEDED' : 'PARTIAL', protocol_version: inputTask.protocol_version,
      task_id: inputTask.task_id, evidence: result.evidence, report, interpretation: output,
      worker, qualification: worker === 'claude-code' ? 'LOCAL_CLAUDE_AND_LIVE_GATEWAY_NOT_QUALIFIED' : 'LOCAL_CODEX_AND_LIVE_GATEWAY_NOT_QUALIFIED', isolation: worker === 'claude-code' ? 'EVIDENCE_TOOL_ONLY_NOT_OS_SANDBOX' : 'READ_ONLY_REQUESTED_NOT_HOST_SECRECY' };
  } catch (error) {
    emit('WORKER_FAILED');
    return { state: controller.signal.reason?.code === 'CANCELLED' || error?.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
      error: publicError(controller.signal.aborted ? controller.signal.reason : error),
      ...(taskId?{diagnostics:{task_id:taskId,...rejection}}:{}) };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (!controller.signal.aborted) controller.abort(new RugError('CLEANUP'));
    killGroup(child, 'SIGKILL'); clearTimeout(killTimer);
    if (childClosed) await childClosed;
    if (relay) { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)); }
    if (home) await fs.rm(home, { recursive: true, force: true });
  }
}
