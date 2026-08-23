import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export type BoundedReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; observedBytes: number };

export type BoundedHashResult =
  | { ok: true; bytesRead: number; contentHash: string }
  | { ok: false; observedBytes: number };

/** Read at most `maxBytes + 1` bytes from one regular file without a stat/read allocation race. */
export function readBoundedFileSync(path: string, maxBytes: number): BoundedReadResult {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new TypeError('not a regular file');
    if (stat.size > maxBytes) return { ok: false, observedBytes: stat.size };

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maxBytes) return { ok: false, observedBytes: bytesRead };
    return { ok: true, bytes: buffer.subarray(0, bytesRead) };
  } finally {
    closeSync(descriptor);
  }
}

/** Hash a regular file incrementally while reading at most `maxBytes + 1` bytes. */
export function hashBoundedFileSync(path: string, maxBytes: number): BoundedHashResult {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new TypeError('not a regular file');
    if (stat.size > maxBytes) return { ok: false, observedBytes: stat.size };

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let bytesRead = 0;
    while (bytesRead <= maxBytes) {
      const remaining = maxBytes + 1 - bytesRead;
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
      if (count === 0) {
        return { ok: true, bytesRead, contentHash: hash.digest('hex') };
      }
      bytesRead += count;
      if (bytesRead > maxBytes) return { ok: false, observedBytes: bytesRead };
      hash.update(buffer.subarray(0, count));
    }
    return { ok: false, observedBytes: bytesRead };
  } finally {
    closeSync(descriptor);
  }
}
