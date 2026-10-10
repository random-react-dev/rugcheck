#!/usr/bin/env node
// Fixed local, read-only tool. JSON-lines MCP fixture-tested; real Codex handshake is not qualified.
import readline from 'node:readline';
import { readBounded } from './hybrid-protocol.mjs';
const [url] = process.argv.slice(2);
let valid = false;
try { const parsed = new URL(url); valid = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && /^\/[a-f0-9]{48}\/evidence$/.test(parsed.pathname) && !parsed.search && !parsed.hash && !parsed.username && !parsed.password; } catch {}
if (!valid) process.exit(2);
let inputBytes = 0;
process.stdin.on('data', chunk => { inputBytes += chunk.length; if (inputBytes > 65536) { process.stdin.destroy(); process.exitCode = 1; } });
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let count = 0, totalBytes = 0;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
for await (const line of rl) {
  totalBytes += Buffer.byteLength(line); if (++count > 30 || totalBytes > 65536) { process.exitCode = 1; break; }
  let request;
  try {
    request = JSON.parse(line); if (request.id === undefined) continue;
    if (request.method === 'initialize') reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'rugcheck', version: '0.4.0' } });
    else if (request.method === 'ping') reply(request.id, {});
    else if (request.method === 'tools/list') reply(request.id, { tools: [{ name: 'read_evidence', description: 'Read evidence for the current public mint task.', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: 'object', properties: {}, additionalProperties: false, required: [] } }] });
    else if (request.method === 'tools/call' && request.params?.name === 'read_evidence' && Object.keys(request.params.arguments ?? {}).length === 0) {
      const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(); const text = await readBounded(response.body);
      JSON.parse(text); reply(request.id, { content: [{ type: 'text', text }], isError: false });
    } else throw new Error();
  } catch { if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'RUGCHECK_TOOL_REJECTED' } }) + '\n'); }
}
