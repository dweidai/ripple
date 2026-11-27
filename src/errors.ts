export class RippleError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RippleError';
  }

  toJSON() {
    return {
      error: this.code,
      status: this.status,
      message: this.message,
      ...this.extra,
    };
  }
}

export const Errors = {
  notFound: (what: string, id: string) =>
    new RippleError('not_found', 404, `${what} ${id} not found`),

  unauthorized: (msg = 'Missing or invalid bearer token') =>
    new RippleError('unauthorized', 401, msg),

  forbidden: (msg: string) =>
    new RippleError('forbidden', 403, msg),

  taken: (itemId: string, existingRunId: string) =>
    new RippleError('taken', 409, `Item ${itemId} already has active run ${existingRunId}`, {
      existing_run_id: existingRunId,
    }),

  fenced: (sentEpoch: number, currentEpoch: number) =>
    new RippleError('fenced', 409, `Run epoch ${sentEpoch} is fenced by epoch ${currentEpoch}`, {
      sent_epoch: sentEpoch,
      current_epoch: currentEpoch,
      directive: 'stop',
    }),

  stalePin: (cardId: string, expectedPin: string, currentPin: string, replacedBy?: string) =>
    new RippleError(
      'stale',
      409,
      `Card ${cardId} pin ${expectedPin} is stale (current: ${currentPin})`,
      {
        card_id: cardId,
        expected_pin: expectedPin,
        current_pin: currentPin,
        replaced_by: replacedBy,
      },
    ),

  alreadyAnswered: (cardId: string, status: string) =>
    new RippleError('already_answered', 409, `Card ${cardId} is already ${status}`, {
      card_id: cardId,
      card_status: status,
    }),

  cycle: (chain: string[]) =>
    new RippleError(
      'cycle',
      409,
      `Blocking card would create wait-for cycle: ${chain.join(' -> ')}`,
      { cycle: chain },
    ),

  conflict: (msg: string) =>
    new RippleError('conflict', 409, msg),

  badRequest: (msg: string) =>
    new RippleError('bad_request', 400, msg),

  rateLimited: (msg: string, retryAfterSec?: number) =>
    new RippleError(
      'rate_limited',
      429,
      msg,
      retryAfterSec !== undefined ? { retry_after_sec: retryAfterSec } : {},
    ),
};
