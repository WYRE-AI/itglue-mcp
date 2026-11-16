const logger = {
  // stdout carries the MCP stdio protocol, so diagnostics go to stderr.
  warn: (message: string, context: Record<string, unknown>): void => {
    console.error(`[WARN] ${message} ${JSON.stringify(context)}`);
  },
};

/**
 * Bounded retry for rate-limited IT Glue responses.
 *
 * Fleet 429 policy: a Retry-After of at most 10 s is waited for and retried
 * once, so a brief burst does not surface as a tool error. With no
 * Retry-After, or a longer one, the error is returned at once (no invented
 * backoff), so a tool call is never held for long.
 *
 * Only replay-safe methods (GET/HEAD/OPTIONS) are retried, on a 429 or on a
 * 503 that carries Retry-After (RFC 9110 9.2.2). IT Glue does not document
 * that a rate-limited write was rejected before it ran, a 503 does not prove
 * a write had no effect, and IT Glue has no idempotency key. So a POST,
 * PATCH or DELETE is never replayed here: it fails at once and the error
 * says how long to wait.
 */
/**
 * A request IT Glue rate-limited (HTTP 429) that was not, or no longer,
 * retried. The message says "Try again in N s." with N = retryAfterSeconds
 * (at least 1; 60 when IT Glue sent no Retry-After).
 */
export class ITGlueRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number
  ) {
    super(message);
    this.name = "ITGlueRateLimitError";
  }
}

export const RATE_LIMIT_RETRY = {
  /** Retries after the first attempt (fleet 429 policy: at most one). */
  maxRetries: 1,
  /** Longest wait that is retried. A missing or larger Retry-After is not retried. */
  maxWaitMs: 10_000,
};

/** Parses a Retry-After value into milliseconds from `now`; undefined if absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  // Otherwise it must be an HTTP date ("Wed, 21 Oct 2015 07:28:00 GMT").
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Whole seconds from a response's Retry-After header (at least 1), or undefined. */
export function retryAfterSecondsOf(res: Response): number | undefined {
  const ms = parseRetryAfter(res.headers?.get('retry-after'));
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Milliseconds to wait before retry number `attempt` (0-based), or
 * undefined when the request should not be retried. Only a Retry-After the
 * vendor sent is waited for: with no header, or one over maxWaitMs, the
 * caller gets the error at once (no invented backoff).
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined): number | undefined {
  if (attempt >= RATE_LIMIT_RETRY.maxRetries) return undefined;
  if (retryAfterMs === undefined || retryAfterMs > RATE_LIMIT_RETRY.maxWaitMs) return undefined;
  return retryAfterMs;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Methods that may be replayed: they cannot create or change anything. */
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * fetch() with the bounded retry above. `makeInit` is called for every
 * attempt so each one gets a fresh timeout signal. Returns the last
 * response, which may still be a 429 for the caller to report.
 */
export async function fetchWithRateLimitRetry(
  url: string,
  label: string,
  makeInit: () => RequestInit
): Promise<Response> {
  const init = makeInit();
  const replaySafe = REPLAY_SAFE_METHODS.has((init.method ?? 'GET').toUpperCase());
  let res = await fetch(url, init);
  for (let attempt = 0; ; attempt++) {
    const retryAfterMs = parseRetryAfter(res.headers?.get('retry-after'));
    const retryable =
      replaySafe && (res.status === 429 || (res.status === 503 && retryAfterMs !== undefined));
    if (!retryable) return res;
    const delay = retryDelayMs(attempt, retryAfterMs);
    if (delay === undefined) return res;
    logger.warn('IT Glue asked us to slow down; retrying', { status: res.status, path: label, delayMs: delay });
    await res.body?.cancel().catch(() => undefined);
    await sleep(delay);
    res = await fetch(url, makeInit());
  }
}
