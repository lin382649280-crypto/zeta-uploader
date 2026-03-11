// 从各种错误结构中解析状态码
export const resolveErrorStatus = (error: unknown): number => {
  const source = error as { statusCode?: number; response?: { status?: number; data?: { code?: number } } };
  return Number(source.response?.status || source.statusCode || source.response?.data?.code || 0);
};

// 判断是否为主动取消/中止
export const isAbortError = (error: unknown) => {
  const source = error as { code?: string; name?: string; message?: string };
  const code = String(source.code || '').toUpperCase();
  if (code === 'ERR_CANCELED') return true;
  const name = String(source.name || '').toLowerCase();
  if (name === 'cancelederror' || name === 'aborterror') return true;
  return String(source.message || '').toLowerCase().includes('canceled');
};

// 判断是否为网络错误（无 response 且常见网络错误码/文案）
export const isLikelyNetworkError = (error: unknown) => {
  const source = error as { code?: string; message?: string; response?: unknown };
  if (source.response) return false;
  const code = String(source.code || '').toUpperCase();
  if (['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(code)) return true;
  const message = String(source.message || '').toLowerCase();
  return message.includes('network') || message.includes('timeout') || message.includes('failed to fetch');
};

// 判断是否为 409 冲突（常见于分片重复上传）
export const isChunkUploadConflictError = (error: unknown) => resolveErrorStatus(error) === 409;

// 判断状态码是否可重试（请求超时/限流/服务端错误）
export const isRetryableStatus = (status: number) => status === 408 || status === 429 || (status >= 500 && status < 600);

// 判断错误是否可重试（网络错误或可重试状态码）
export const isRetryableError = (error: unknown) =>
  isLikelyNetworkError(error) || isRetryableStatus(resolveErrorStatus(error));
