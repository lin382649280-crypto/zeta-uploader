export const toInt = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
};

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
