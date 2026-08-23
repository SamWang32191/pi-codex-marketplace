import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hashBoundedFileSync, readBoundedFileSync } from '../../../src/registration/bounded-read.js';

describe('bounded regular-file I/O', () => {
  it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'bounded-read-test-'));
    const fifo = join(root, 'profile.yaml');
    try {
      execFileSync('mkfifo', [fifo]);

      expect(() => readBoundedFileSync(fifo, 1024)).toThrow('not a regular file');
      expect(() => hashBoundedFileSync(fifo, 1024)).toThrow('not a regular file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
