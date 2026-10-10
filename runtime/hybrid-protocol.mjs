import { randomUUID } from 'node:crypto';
import { request, analyze, validateInterpretation, canonical } from './core.mjs';
import { validate, evidenceSchema, requestSchema } from './schema.mjs';
import { invariant } from './errors.mjs';
export const PROTOCOL = 'rugcheck-agent3/1';
export const MAX_BODY = 512 * 1024;
export const taskSchema = {
  type: 'object', additionalProperties: false,
  required: ['protocol_version', 'action', 'task_id', 'request'],
  properties: { protocol_version: { const: PROTOCOL }, action: { const: 'interpret-evidence' },
    task_id: { type: 'string', pattern: '^[a-f0-9-]{36}$', maxLength: 36 }, request: requestSchema }
};
export function task(input) {
  return validateTask({ protocol_version: PROTOCOL, action: 'interpret-evidence', task_id: randomUUID(), request: input });
}
export function validateTask(value) {
  validate(taskSchema, value); request(value.request);
  invariant(Buffer.byteLength(JSON.stringify(value)) <= 4096, 'TASK_TOO_LARGE');
  return value;
}
export function validateResult(value, input, now = Date.now()) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'GATEWAY_RESULT_INVALID');
  invariant(Object.keys(value).sort().join(',') === 'evidence,interpretation,protocol_version,task_id', 'GATEWAY_RESULT_INVALID');
  invariant(value.protocol_version === PROTOCOL && value.task_id === input.task_id, 'GATEWAY_BINDING_MISMATCH');
  validate(evidenceSchema, value.evidence);
  const report = analyze(value.evidence, input.request, now);
  validateInterpretation(value.interpretation, report, input.task_id);
  // Close the original optional limitation prose channel as well as explanation text.
  invariant(canonical(value.interpretation.limitations) === canonical(report.limitations), 'MODEL_UNSUPPORTED_LIMITATIONS');
  return report;
}
export async function readBounded(stream, limit = MAX_BODY) {
  let size = 0; const chunks = [];
  for await (const chunk of stream) { size += chunk.length; invariant(size <= limit, 'BODY_TOO_LARGE'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString('utf8');
}
export function gatewayURL(value) {
  const url = new URL(value);
  invariant(!url.username && !url.password && !url.search && !url.hash, 'ENDPOINT_MUST_BE_NONSECRET');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  invariant(url.protocol === 'https:' || (url.protocol === 'http:' && loopback), 'HTTPS_REQUIRED');
  return url;
}
export const EVIDENCE_TOOL = { type: 'function', name: 'mcp__rugcheck__read_evidence', description: 'Read evidence for the current public mint task.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true };
export function validateToolOutput(value, evidence, input) {
  invariant(value && Object.keys(value).sort().join(',') === 'evidence,report', 'TOOL_OUTPUT_INVALID');
  invariant(canonical(value.evidence) === canonical(evidence), 'TOOL_EVIDENCE_CHANGED');
  const expected = analyze(evidence, input.request);
  invariant(Number.isSafeInteger(value.report?.age_ms) && value.report.age_ms >= 0 &&
    value.report.age_ms <= expected.age_ms + 5000, 'TOOL_AGE_INVALID');
  // age_ms advances in transit. Compare all semantic/freshness fields at validation time;
  // a stale-threshold crossing fails closed rather than trusting the old freshness claim.
  invariant(canonical({ ...value.report, age_ms: expected.age_ms }) === canonical(expected), 'TOOL_REPORT_CHANGED');
  return value;
}
export function decodeToolOutput(value) {
  if (typeof value === 'string') {
    // Codex 0.147 wraps MCP text with timing metadata. The remaining JSON still
    // receives the exact evidence/report comparison; arbitrary prose is rejected.
    value = value.replace(/^Wall time: [0-9]+(?:\.[0-9]+)? seconds(?:\n|\\n)Output:(?:\n|\\n)/, '');
    try { value = JSON.parse(value); } catch { invariant(false,'TOOL_OUTPUT_JSON_INVALID'); }
  }
  if (Array.isArray(value)) {
    invariant(value.length === 1 && value[0].type === 'text', 'TOOL_OUTPUT_INVALID'); try { return JSON.parse(value[0].text); } catch { invariant(false,'TOOL_OUTPUT_JSON_INVALID'); }
  }
  if (value?.content) {
    invariant(Object.keys(value).every(k => ['content','isError'].includes(k)) && !value.isError, 'TOOL_OUTPUT_INVALID');
    return decodeToolOutput(value.content);
  }
  return value;
}
