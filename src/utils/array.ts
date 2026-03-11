// 在已排序数组中插入一个值，并保持有序且不重复
export const insertSortedUnique = (sorted: number[], value: number) => {
  let low = 0;
  let high = sorted.length;
  // 二分查找插入位置
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  // 避免重复插入
  if (sorted[low] !== value) {
    sorted.splice(low, 0, value);
  }
  return sorted;
};
