import type { RetryContext, RetryDelayResolver } from '../types';

// 计算重试延迟时间
// - 支持自定义 resolveRetryDelayMs
// - 默认使用指数退避 + 抖动
export const resolveRetryDelayMs = (
  context: RetryContext,
  options: {
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio: number;
    customResolver?: RetryDelayResolver;
  },
) => {
  if (options.customResolver) {
    const customValue = options.customResolver(context);
    if (Number.isFinite(customValue) && customValue >= 0) {
      return Math.floor(customValue);
    }
  }
  const base = Math.max(0, options.baseDelayMs);
  const max = Math.max(base, options.maxDelayMs);
  // 指数退避：base * 2^attempt
  const expDelay = Math.min(max, base * 2 ** Math.max(0, context.attempt));
  const jitterRatio = Math.max(0, Math.min(1, options.jitterRatio));
  if (!jitterRatio) return Math.floor(expDelay);
  // 抖动：在 [-jitter, +jitter] 区间随机
  const jitter = expDelay * jitterRatio;
  const offset = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.floor(expDelay + offset));
};
