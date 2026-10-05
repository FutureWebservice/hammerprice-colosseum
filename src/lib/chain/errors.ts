import { ApiError, type ErrorCode } from '@/contracts';

/** An ApiError raised by the chain layer (balance_unavailable, rpc_unavailable, tx_mismatch...). The route layer already knows how to answer it. */
export class ChainError extends ApiError {
  constructor(code: ErrorCode, reason?: string, extra: Record<string, unknown> = {}) {
    super(code, reason, extra);
    this.name = 'ChainError';
  }
}

/** A bad or polluted environment value. Thrown loudly and early; never contains the value itself when it may be a secret. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
