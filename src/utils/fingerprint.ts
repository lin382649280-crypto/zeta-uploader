import { FINGERPRINT_SAMPLE_BYTES } from '../constants';

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('');

export const buildFileFingerprint = async (file: File) => {
  const fallback = `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
  const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : undefined;
  if (!subtle || typeof TextEncoder === 'undefined') return fallback;

  try {
    const sample = Math.min(FINGERPRINT_SAMPLE_BYTES, file.size);
    const middleStart = Math.max(0, Math.floor(file.size / 2) - Math.floor(sample / 2));
    const parts = [
      new TextEncoder().encode(fallback),
      new Uint8Array(await file.slice(0, sample).arrayBuffer()),
      new Uint8Array(await file.slice(middleStart, middleStart + sample).arrayBuffer()),
      new Uint8Array(await file.slice(Math.max(0, file.size - sample), file.size).arrayBuffer()),
    ];
    const mergedLength = parts.reduce((sum, item) => sum + item.length, 0);
    const merged = new Uint8Array(mergedLength);
    let offset = 0;
    parts.forEach((item) => {
      merged.set(item, offset);
      offset += item.length;
    });
    const digest = await subtle.digest('SHA-256', merged);
    return toHex(digest);
  } catch {
    return fallback;
  }
};
