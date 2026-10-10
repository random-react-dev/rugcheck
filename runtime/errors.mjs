export class RugError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
export function invariant(ok, code, message) { if (!ok) throw new RugError(code, message); }
export function publicError(e) { return { code: e instanceof RugError ? e.code : 'INTERNAL_ERROR' }; }
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
