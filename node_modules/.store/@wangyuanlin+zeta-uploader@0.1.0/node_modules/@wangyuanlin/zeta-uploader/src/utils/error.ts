export const resolveErrorStatus = (error: unknown): number => {
  const source = error as { statusCode?: number; response?: { status?: number; data?: { code?: number } } };
  return Number(source.response?.status || source.statusCode || source.response?.data?.code || 0);
};

export const isAbortError = (error: unknown) => {
  const source = error as { code?: string; name?: string; message?: string };
  const code = String(source.code || '').toUpperCase();
  if (code === 'ERR_CANCELED') return true;
  const name = String(source.name || '').toLowerCase();
  if (name === 'cancelederror' || name === 'aborterror') return true;
  return String(source.message || '').toLowerCase().includes('canceled');
};

export const isLikelyNetworkError = (error: unknown) => {
  const source = error as { code?: string; message?: string; response?: unknown };
  if (source.response) return false;
  const code = String(source.code || '').toUpperCase();
  if (['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(code)) return true;
  const message = String(source.message || '').toLowerCase();
  return message.includes('network') || message.includes('timeout') || message.includes('failed to fetch');
};

export const isChunkUploadConflictError = (error: unknown) => resolveErrorStatus(error) === 409;
