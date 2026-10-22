import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION } from './index';

describe('shared', () => {
  it('exports the snapshot format version', () => {
    expect(FORMAT_VERSION).toBe(1);
  });
});
