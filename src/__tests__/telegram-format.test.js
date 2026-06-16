import { describe, it, expect } from 'vitest';
import { terseStatus, detailBody } from '../telegram/format.js';

describe('terseStatus', () => {
  it('returns the first line, trimmed, for multi-line text', () => {
    expect(terseStatus('Done: 3 files changed\n\n--- diff ---\n+a')).toBe('Done: 3 files changed');
  });
  it('truncates a long single line to <= 120 chars with an ellipsis', () => {
    const long = 'x'.repeat(300);
    const out = terseStatus(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });
  it('returns a fallback for empty text', () => {
    expect(terseStatus('')).toBe('(no output)');
  });
});

describe('detailBody', () => {
  it('returns null when the text fits in the terse line (nothing extra to send)', () => {
    expect(detailBody('short reply')).toBeNull();
  });
  it('chunks text longer than 4096 chars into <=4096 pieces', () => {
    const big = 'y'.repeat(9000);
    const chunks = detailBody(big);
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBe(3);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(4096));
  });
});
