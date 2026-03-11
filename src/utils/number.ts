// 将任意值安全转为整数
// - 非数字或 NaN 则返回 fallback
// - 始终向下取整
export const toInt = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
};

// 数值范围限制
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
