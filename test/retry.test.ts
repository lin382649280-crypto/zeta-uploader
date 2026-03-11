import { describe, expect, it } from 'vitest';
import { resolveRetryDelayMs } from '../src/utils/retry';
import type { RetryContext } from '../src/types';

describe('retry delay', () => {
  it('uses exponential backoff with no jitter', () => {
    const context: RetryContext = {
      error: new Error('fail'),
      attempt: 1,
      maxAttempts: 3,
      isLastAttempt: false,
      statusCode: 500,
      isNetworkError: false,
      isConflictError: false,
    };
    const delay = resolveRetryDelayMs(context, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitterRatio: 0,
    });
    expect(delay).toBe(200);
  });
});
