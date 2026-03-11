export const insertSortedUnique = (sorted: number[], value: number) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  if (sorted[low] !== value) {
    sorted.splice(low, 0, value);
  }
  return sorted;
};
