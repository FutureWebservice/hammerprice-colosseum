/** The ONE error type of the AI adapter. It carries a kind and (for `http`) a status, never upstream text, a prompt or a key. */
export type AiErrorKind = 'unconfigured' | 'network' | 'timeout' | 'http' | 'blocked' | 'truncated' | 'empty' | 'schema';

export class AiError extends Error {
  constructor(readonly kind: AiErrorKind, readonly status?: number) {
    super(status ? `ai ${kind} ${status}` : `ai ${kind}`);
    this.name = 'AiError';
  }
}
