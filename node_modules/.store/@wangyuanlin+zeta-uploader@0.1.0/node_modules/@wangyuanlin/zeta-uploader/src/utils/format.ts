export const formatFileSize = (size: number) => {
  const safeSize = Number(size || 0);
  if (safeSize <= 0) return '0 B';
  if (safeSize < 1024) return `${safeSize} B`;
  if (safeSize < 1024 * 1024) return `${(safeSize / 1024).toFixed(1)} KB`;
  if (safeSize < 1024 * 1024 * 1024) return `${(safeSize / (1024 * 1024)).toFixed(1)} MB`;
  return `${(safeSize / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};
