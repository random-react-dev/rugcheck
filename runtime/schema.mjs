import { RugError } from './errors.mjs';

// Small closed-schema validator. Schemas use only this documented subset.
export function validate(schema, value, path = '$') {
  const fail = () => { throw new RugError('SCHEMA_INVALID', `Invalid field at ${path}`); };
  if (schema.anyOf) {
    for (const s of schema.anyOf) { try { validate(s, value, path); return value; } catch {} }
    fail();
  }
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.const !== undefined && value !== schema.const) fail();
  const t = schema.type;
  if (t === 'null') { if (value !== null) fail(); }
  if (t === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? 100000) || value.length < (schema.minLength ?? 0)) fail();
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail();
  }
  if (t === 'integer' || t === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (t === 'integer' && !Number.isSafeInteger(value))) fail();
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail();
  }
  if (t === 'boolean' && typeof value !== 'boolean') fail();
  if (t === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 10000) || value.length < (schema.minItems ?? 0)) fail();
    value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`));
  }
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) fail();
    for (const [k, v] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, k)) { if (schema.additionalProperties === false) fail(); }
      else validate(schema.properties[k], v, `${path}.${k}`);
    }
  }
  return value;
}
const str = (maxLength = 256) => ({ type: 'string', maxLength });
const enumeration = values => ({ type: 'string', enum: values });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const array = (items, maxItems = 100) => ({ type: 'array', items, maxItems });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, optional = []) => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)), additionalProperties: false });
export const raw = { type: 'string', pattern: '^(0|[1-9][0-9]{0,19})$', maxLength: 20 };
export const publicKey = { type: 'string', minLength: 32, maxLength: 44, pattern: '^[1-9A-HJ-NP-Za-km-z]+$' };
export const sourceSchema = object({ id: { type: 'string', minLength: 1, maxLength: 64 }, observed_at: { type: 'string', maxLength: 40, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$' }, slot: raw, commitment: enumeration(['confirmed', 'finalized']), method: str(64), response_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['response_digest']);
export const extensionSchema = object({ type_id: integer(0, 65535), name: str(64), status: enumeration(['observed', 'unsupported', 'unknown']), detail: str(512), fields: array(object({ name: str(64), value: nullable(str(512)), unit: enumeration(['address', 'raw', 'epoch', 'basis_points', 'boolean', 'state', 'unix_seconds', 'ui_multiplier', 'count']) }), 32), layout_ref: str(128) }, ['fields', 'layout_ref']);
const poolVerification = object({ layout_ref: str(128), program: publicKey, pool_address_kind: enumeration(['canonical_pda', 'program_owned_noncanonical']), authority: publicKey, token_vault: publicKey, quote_vault: publicKey, quote_mint: publicKey, config: publicKey, lp_mint: publicKey, lp_supply: raw, pool_lp_bookkeeping: raw, status_flags: integer(0, 7), swap_enabled: { type: 'boolean' }, open_time: raw, open_at_observation: nullable({ type: 'boolean' }), token_decimals: integer(0, 255), quote_decimals: integer(0, 255), trade_fee_rate: raw, creator_fee_rate: raw, creator_fee_enabled: { type: 'boolean' }, creator_fee_on: integer(0, 2), protocol_fee_rate: raw, fund_fee_rate: raw, fee_rate_denominator: { const: '1000000' }, limits: array(str(128), 20) });
export const evidenceSchema = object({
  schema_version: { const: '1.0' }, chain: { const: 'solana-mainnet-beta' }, mint: publicKey,
  account_type: enumeration(['mint', 'wallet', 'token_account', 'program', 'not_found', 'unknown']),
  token_program: enumeration(['spl-token', 'token-2022', 'unsupported']),
  initialized: nullable({ type: 'boolean' }), supply: nullable(raw), decimals: nullable(integer(0, 255)),
  mint_authority: nullable(publicKey), mint_authority_status: enumeration(['observed', 'unknown']),
  freeze_authority: nullable(publicKey), freeze_authority_status: enumeration(['observed', 'unknown']),
  metadata: str(4096), source: sourceSchema, observations: array(sourceSchema, 20),
  accounts: array(object({ address: publicKey, mint: publicKey, authority: publicKey, amount: raw, label: enumeration(['unknown', 'pool', 'custody']), label_verified: { type: 'boolean' }, source_id: str(64), state: integer(0, 2), delegate: nullable(publicKey), close_authority: nullable(publicKey), extensions: array(extensionSchema, 64) }, ['state', 'delegate', 'close_authority', 'extensions']), 20),
  pools: array(object({ address: publicKey, dex: str(64), layout: str(64), verified: { type: 'boolean' }, mint: publicKey, token_reserve: raw, quote_reserve: raw, token_fees: raw, quote_fees: raw, source_id: str(64), verification: poolVerification }, ['verification']), 3),
  extensions: array(extensionSchema, 64), extension_coverage: enumeration(['observed', 'unknown']),
  missing: array(str(128)), conflicts: array(str(128)), truncated: { type: 'boolean' }
}, ['extension_coverage']);
export const requestSchema = object({ chain: { const: 'solana-mainnet-beta' }, mint: publicKey, profile: { const: 'core-cpmm-v1' } });
export const interpretationSchema = object({
  schema_version: { const: '1.0' }, task_id: str(64), evidence_digest: str(64),
  status: enumeration(['complete', 'partial']),
  explanations: array(object({ finding_id: str(128), fact_ids: array(str(128), 20), evidence_ids: array(str(64), 32), text: str(1000) }), 100),
  limitations: array(str(256), 30)
});
export const backendRequestSchema = object({ schema_version: { const: '1.0' }, chain: { const: 'solana-mainnet-beta' }, mint: publicKey, profile: { const: 'core-cpmm-v1' }, max_age_seconds: integer(0, 20) });
