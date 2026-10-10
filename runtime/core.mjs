import crypto from 'node:crypto';
import { invariant, RugError } from './errors.mjs';
import { validate, requestSchema, evidenceSchema, interpretationSchema } from './schema.mjs';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function decode58(text) {
  invariant(typeof text === 'string' && text.length >= 32 && text.length <= 44, 'INVALID_ADDRESS');
  let n = 0n;
  for (const c of text) { const d = alphabet.indexOf(c); invariant(d >= 0, 'INVALID_ADDRESS'); n = n * 58n + BigInt(d); }
  let bytes = [];
  while (n) { bytes.push(Number(n & 255n)); n >>= 8n; }
  bytes.reverse();
  let zeros = 0; for (const c of text) { if (c !== '1') break; zeros++; }
  const result = Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]);
  invariant(result.length === 32, 'INVALID_ADDRESS');
  return result;
}
export function encode58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`), out = '';
  while (n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
export function address(s) { invariant(encode58(decode58(s)) === s, 'INVALID_ADDRESS'); return s; }
export function request(input) { validate(requestSchema, input); address(input.mint); return input; }
export function u64(s) { invariant(typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s), 'INVALID_AMOUNT'); const n = BigInt(s); invariant(n <= 18446744073709551615n, 'INVALID_AMOUNT'); return n; }
export function units(s, decimals) {
  const n = u64(s); invariant(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, 'INVALID_DECIMALS');
  if (!decimals) return n.toString();
  const v = n.toString().padStart(decimals + 1, '0');
  return `${v.slice(0, -decimals)}.${v.slice(-decimals)}`;
}
// Percent rendered to 4 decimal places, floor; exact numerator/denominator retained.
export function share(n, d) { return d === 0n ? null : { numerator: n.toString(), denominator: d.toString(), percent: units((n * 1000000n / d).toString(), 4), rounding: 'floor-4dp' }; }
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const digest = v => crypto.createHash('sha256').update(canonical(v)).digest('hex');
export function inert(s) { return String(s).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[<>`]/g, '').slice(0, 1000); }

export function analyze(evidence, expected, now = Date.now()) {
  request(expected); validate(evidenceSchema, evidence);
  invariant(evidence.mint === expected.mint && evidence.chain === expected.chain, 'IDENTITY_MISMATCH');
  address(evidence.mint);
  const observed = Date.parse(evidence.source.observed_at);
  invariant(Number.isFinite(observed) && observed <= now + 5000, 'INVALID_TIMESTAMP');
  u64(evidence.source.slot);
  const sources = [evidence.source, ...evidence.observations], sourceIds = new Set();
  for (const s of sources) {
    invariant(!sourceIds.has(s.id), 'DUPLICATE_SOURCE'); sourceIds.add(s.id); u64(s.slot);
    invariant(Number.isFinite(Date.parse(s.observed_at)) && Date.parse(s.observed_at) <= now + 5000, 'INVALID_TIMESTAMP');
  }
  const oldest = Math.min(...sources.map(s => Date.parse(s.observed_at)));
  const stale = now - oldest > 20000;
  const missing = [...evidence.missing], conflicts = [...evidence.conflicts];
  if (stale) missing.push('source_stale');
  if (evidence.truncated) missing.push('coverage_truncated');
  const facts = [], findings = [];
  const add = (id, value, status = 'observed', ids = [evidence.source.id]) => facts.push({ id, value, status, evidence_ids: ids });
  const finding = (id, factIds, text) => findings.push({ id, fact_ids: factIds, evidence_ids: [...new Set(factIds.flatMap(id => facts.find(f => f.id === id)?.evidence_ids ?? []))], text });
  add('identity', evidence.account_type);
  const supported = evidence.account_type === 'mint' && evidence.initialized === true && evidence.token_program !== 'unsupported';
  if (!supported) missing.push('unsupported_or_uninitialized_mint');
  for (const type of ['mint', 'freeze']) {
    const key = `${type}_authority`;
    const status = evidence[`${key}_status`];
    if (evidence[key] !== null) address(evidence[key]);
    add(key, evidence[key], status);
    if (status === 'unknown') { missing.push(key); finding(`${key}.unknown`, [key], `${type} authority is unknown.`); }
    else if (evidence[key]) finding(`${key}.present`, [key], `${type} authority is present; capability is not proof of intent.`);
  }
  const supply = evidence.supply === null ? null : u64(evidence.supply);
  if (supply === null || evidence.decimals === null) missing.push('supply_or_decimals');
  add('supply_raw', evidence.supply, supply === null ? 'unknown' : 'observed');
  add('supply_units', supply === null || evidence.decimals === null ? null : units(evidence.supply, evidence.decimals), supply === null || evidence.decimals === null ? 'unknown' : 'observed');
  if (supply !== null && supply > 0n && evidence.accounts.length === 0) missing.push('holder_sample_missing');
  const seen = new Set(), owners = new Map(); let sampled = 0n, pool = 0n, custody = 0n;
  const verifiedVaults = new Map(evidence.pools.filter(p => p.verified && p.dex === 'raydium-cpmm' && p.layout === 'cpmm-v1' && p.verification?.program === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C').map(p => [p.verification.token_vault, p]));
  const holderIds = [...new Set(evidence.accounts.map(a => a.source_id))];
  for (const a of evidence.accounts) {
    address(a.address); address(a.authority); address(a.mint);
    invariant(a.mint === expected.mint && sourceIds.has(a.source_id), 'ACCOUNT_IDENTITY_MISMATCH');
    invariant(!seen.has(a.address), 'DUPLICATE_ACCOUNT'); seen.add(a.address);
    const amount = u64(a.amount); sampled += amount;
    owners.set(a.authority, (owners.get(a.authority) ?? 0n) + amount);
    const verifiedPool = verifiedVaults.get(a.address);
    if (verifiedPool && verifiedPool.verification.authority === a.authority) {
      pool += amount;
      if (a.amount !== verifiedPool.token_reserve) conflicts.push(`pool_sample_balance_changed:${a.address}`);
    } else if (a.label !== 'unknown') missing.push(`unverified_account_label:${a.address}`);
    // No supported custody verifier exists; supplied custody labels never become fact.
    if (a.state === 2 || a.delegate || a.extensions?.length) {
      const id = `account_controls.${a.address}`;
      add(id, { state: a.state ?? null, delegate: a.delegate ?? null, close_authority: a.close_authority ?? null, extensions: a.extensions ?? [] }, 'observed', [a.source_id]);
      finding(id, [id], 'A sampled token account has account-level controls; its balance is not proof of freely transferable beneficial ownership.');
      if (a.extensions?.some(e => e.status !== 'observed')) missing.push(`account_extension_unsupported:${a.address}`);
    }
  }
  if (supply !== null && sampled > supply) conflicts.push('sample_exceeds_supply');
  add('sampled_amount', sampled.toString(), 'observed', holderIds);
  add('sampled_owner_count', owners.size, 'observed', holderIds);
  const sampledShare = supply !== null && sampled <= supply ? share(sampled, supply) : null;
  add('sampled_share', sampledShare, sampledShare === null ? 'unknown' : 'observed', [...new Set([evidence.source.id, ...holderIds])]);
  add('verified_pool_sample', pool.toString(), 'observed', [...new Set([...holderIds, ...evidence.pools.map(p => p.source_id)])]); add('verified_custody_sample', custody.toString(), 'unknown');
  const pools = [], poolAddresses = new Set();
  for (const p of evidence.pools) {
    address(p.address); invariant(p.mint === expected.mint && sourceIds.has(p.source_id), 'POOL_IDENTITY_MISMATCH');
    invariant(!poolAddresses.has(p.address), 'DUPLICATE_POOL'); poolAddresses.add(p.address);
    if (!p.verified || p.dex !== 'raydium-cpmm' || p.layout !== 'cpmm-v1' || !p.verification) { missing.push(`pool_unsupported:${p.address}`); continue; }
    const v = p.verification;
    invariant(v.program === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' && v.layout_ref === 'raydium-io/raydium-cp-swap@b3187ae53a1b95a201f855a59024a12ca8f5b51a', 'POOL_VERIFICATION_INVALID');
    for (const key of ['authority', 'token_vault', 'quote_vault', 'quote_mint', 'config', 'lp_mint']) address(v[key]);
    missing.push(...v.limits);
    const tr = u64(p.token_reserve), qr = u64(p.quote_reserve), tf = u64(p.token_fees), qf = u64(p.quote_fees);
    invariant(tf <= tr && qf <= qr, 'INVALID_RESERVES');
    pools.push({ address: p.address, token_reserve_after_fees: (tr - tf).toString(), quote_reserve_after_fees: (qr - qf).toString(), source_id: p.source_id, verification: v, usd_value: null, lp_lock_status: 'unknown' });
    const id = `pool.${p.address}`; add(id, pools.at(-1), 'observed', [p.source_id]);
    finding(id, [id], 'Pool reserves are net of recorded protocol, fund and creator fees. Verified account relationships do not establish LP locking or future sellability.');
    if (!v.swap_enabled || v.open_at_observation === false) finding(`${id}.restricted`, [id], 'The pool is not open for swaps at this observation.');
  }
  if (pools.length === 0) missing.push('no_verified_supported_pool');
  const extensionTypes = new Set();
  for (const e of evidence.extensions) {
    invariant(!extensionTypes.has(e.type_id), 'DUPLICATE_EXTENSION'); extensionTypes.add(e.type_id);
    const id = `extension.${e.type_id}`, fields = e.fields ?? [], value = name => fields.find(f => f.name === name)?.value;
    const ids = [evidence.source.id, ...evidence.observations.filter(s => (e.type_id === 1 && s.method === 'getEpochInfo') || (e.type_id === 25 && s.method === 'getBlockTime')).map(s => s.id)];
    add(id, { name: inert(e.name), detail: inert(e.detail), fields, layout_ref: e.layout_ref ?? null }, e.status, ids);
    if (e.status !== 'observed') missing.push(`extension:${e.type_id}`);
    else if (!e.layout_ref || !e.fields) missing.push(`extension_semantics_unverified:${e.type_id}`);
    else {
      const text = {
        1: 'Transfer fees and fee authorities are present in the decoded configuration. The active fee depends on the observed epoch; caps and rounding apply.',
        3: 'The mint has a close-authority extension. Closing still requires the token program conditions; its presence does not prove intent.',
        6: value('default_state') === 'frozen' ? 'New token accounts default to frozen; this does not mean every existing account is frozen.' : 'New token accounts default to initialized in this configuration.',
        9: 'This mint is non-transferable.',
        10: 'Interest-bearing configuration affects UI amounts; it does not mint raw supply or change raw holder shares.',
        12: value('permanent_delegate') ? 'A permanent delegate is configured and can exercise token-program delegate powers. This is capability, not proof of abuse.' : 'No permanent delegate is configured in this extension at this observation.',
        14: value('program_id') ? 'Transfers invoke the configured hook program. Hook behavior and future sellability are not established.' : 'No hook program is currently configured; a retained hook authority may change that.',
        18: 'The metadata pointer and its authority are decoded. Metadata identity is not proof of token authenticity.',
        19: 'On-chain metadata is bound to this mint. Metadata text and URLs are untrusted and were not followed.',
        25: 'Scaled UI amounts are display transformations. Raw balances, reserves and concentration use unscaled integer units.',
        26: value('paused') === 'true' ? 'The mint is paused at this observation; token-program mint, burn and transfer operations are restricted.' : 'The mint is not paused at this observation; a retained pause authority may change that.',
        28: 'Burning requires the configured permissioned-burn authority; this is distinct from mint and freeze authority.'
      }[e.type_id];
      if (text) finding(id, [id], text);
      if (e.type_id === 1 && value('current_epoch') === null) missing.push('transfer_fee_epoch_unknown');
      if (e.type_id === 14 && value('program_id')) missing.push('transfer_hook_behavior_unknown');
      if (e.type_id === 25 && value('effective_multiplier') === null) missing.push('scaled_ui_effective_time_unknown');
    }
  }
  if (evidence.token_program === 'token-2022' && evidence.extension_coverage !== 'observed') missing.push('token_2022_extension_coverage_unverified');
  const limitations = ['top-20 token-account sample is not a complete owner ranking', 'account authorities are not distinct people or proven common control', 'only verified Raydium CPMM pool evidence is covered', 'LP locking and future sellability are not established'];
  finding('coverage', ['identity', 'sampled_amount', 'sampled_share'], 'Coverage is limited to the declared account sample and supported pools.');
  return {
    schema_version: '1.0', request: expected, evidence_digest: digest(evidence),
    status: !supported ? 'unsupported' : missing.length || conflicts.length ? 'partial' : 'complete',
    source: evidence.source, sources, snapshot_atomic: false, age_ms: Math.max(0, now - oldest), stale,
    verification: 'TRUSTED_COLLECTOR_EVIDENCE_NOT_INDEPENDENT_CONSENSUS_VERIFICATION', facts, findings, pools,
    holders: { sample_scope: 'top-20-token-accounts', observed_share: sampledShare, owner_totals: [...owners].map(([authority, amount]) => ({ authority, amount: amount.toString() })).sort((a, b) => a.authority.localeCompare(b.authority)) },
    missing: [...new Set(missing)], conflicts: [...new Set(conflicts)], limitations,
    source_url: `https://explorer.solana.com/address/${evidence.mint}`
  };
}
export function validateInterpretation(value, report, taskId) {
  validate(interpretationSchema, value);
  invariant(value.task_id === taskId && value.evidence_digest === report.evidence_digest, 'WORKER_BINDING_MISMATCH');
  invariant(!(report.status !== 'complete' && value.status === 'complete'), 'WORKER_HIDES_UNKNOWNS');
  invariant(report.limitations.every(l => value.limitations.includes(l)), 'WORKER_HIDES_LIMITATIONS');
  const ids = new Set();
  for (const x of value.explanations) {
    const f = report.findings.find(f => f.id === x.finding_id);
    invariant(f && !ids.has(x.finding_id), 'WORKER_UNKNOWN_FINDING'); ids.add(x.finding_id);
    invariant(canonical(x.fact_ids) === canonical(f.fact_ids) && canonical(x.evidence_ids) === canonical(f.evidence_ids), 'WORKER_UNKNOWN_REFERENCE');
    // v0.1 closes the prose channel to approved evidence-bound templates. Model chooses coverage/order, not new claims.
    invariant(x.text === f.text, 'WORKER_UNSUPPORTED_PROSE');
  }
  invariant(ids.size === report.findings.length, 'WORKER_OMITS_FINDING');
  return value;
}
