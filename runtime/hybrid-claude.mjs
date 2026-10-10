// Public transport only. No private model instructions or provider credentials.
import path from 'node:path';
import { invariant } from './errors.mjs';
import { EVIDENCE_TOOL } from './hybrid-protocol.mjs';
export function claudeEnvironment(home, base, token, model) {
  return { CLAUDE_CONFIG_DIR: path.join(home, 'claude'), ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: token, ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1', ENABLE_TOOL_SEARCH: 'false', API_TIMEOUT_MS: '20000',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '12000', MAX_THINKING_TOKENS: '0' };
}
export function claudeArguments(model, mcpFile) {
  return ['--print', '--bare', '--output-format', 'json', '--model', model, '--max-turns', '4',
    '--tools', '', '--allowedTools', EVIDENCE_TOOL.name, '--permission-mode', 'dontAsk',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true,"disableClaudeAiConnectors":true}',
    '--strict-mcp-config', '--mcp-config', mcpFile, '--disable-slash-commands', '--no-chrome', '--no-session-persistence'];
}
export function normalizeClaudeRequest(body) {
  invariant(body && Array.isArray(body.messages) && typeof body.stream === 'boolean', 'CLAUDE_REQUEST_INVALID');
  const tool = body.tools?.find(t => t.name === EVIDENCE_TOOL.name);
  invariant(tool?.input_schema?.type === 'object' && Object.keys(tool.input_schema.properties ?? {}).length === 0 &&
    (tool.input_schema.required ?? []).length === 0, 'CLAUDE_EVIDENCE_TOOL_MISSING');
  const input = [];
  for (const message of body.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) if (block.type === 'tool_result') {
      invariant(!block.is_error, 'CLAUDE_TOOL_FAILED');
      input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: block.content });
    }
  }
  return { model: body.model, stream: body.stream, tools: [EVIDENCE_TOOL], input };
}
export function sendClaudeResponse(res, response, model, streaming) {
  const item = response.output[0], tool = item.type === 'function_call';
  const content = tool ? { type: 'tool_use', id: item.call_id, name: item.name, input: {} } : { type: 'text', text: item.content[0].text };
  const message = { id: response.id, type: 'message', role: 'assistant', model, content: [content],
    stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
  if (!streaming) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  event('content_block_start', { index: 0, content_block: tool ? { ...content, input: {} } : { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: content.text } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 0 } });
  event('message_stop', {}); res.end();
}
export function parseClaudeOutput(text) {
  let value;
  try { value = JSON.parse(text); } catch { invariant(false, 'WORKER_OUTPUT_INVALID'); }
  invariant(value?.type === 'result' && value.subtype === 'success' && value.is_error === false && typeof value.result === 'string', 'CLAUDE_RESULT_INVALID');
  try { return JSON.parse(value.result); } catch { invariant(false, 'WORKER_OUTPUT_INVALID'); }
}
