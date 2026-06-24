/**
 * src/__tests__/comms-chunk.test.js
 *
 * Unit tests for src/comms/chunk.js — pure text splitter.
 */
import { describe, it, expect } from 'vitest';
import { chunkText, LIMITS } from '../comms/chunk.js';

describe('LIMITS', () => {
  it('exports expected surface limits', () => {
    expect(LIMITS.discord).toBe(2000);
    expect(LIMITS.telegram).toBe(4096);
    expect(LIMITS.voice).toBe(0);
  });
});

describe('chunkText', () => {
  it('returns [text] when text fits within the limit', () => {
    const text = 'Hello, world!';
    expect(chunkText(text, 2000)).toEqual([text]);
  });

  it('returns [] for an empty string', () => {
    expect(chunkText('', 2000)).toEqual([]);
  });

  it('returns [] for a whitespace-only string', () => {
    expect(chunkText('   \n\t  ', 2000)).toEqual([]);
  });

  it('returns [text] unchanged when limit is 0 (voice surface)', () => {
    const long = 'x'.repeat(9999);
    expect(chunkText(long, 0)).toEqual([long]);
  });

  it('returns [text] unchanged when limit is negative', () => {
    const text = 'short text';
    expect(chunkText(text, -1)).toEqual([text]);
  });

  it('splits on \\n\\n boundary when present within limit', () => {
    // Build two paragraphs whose combined length exceeds 2000 chars.
    // The \n\n falls at position 1200, which is >= 500 so the source algorithm
    // uses it as the split point (mirrors message-handlers.js ~line 1006-1008).
    const para1 = 'A'.repeat(1200);
    const para2 = 'B'.repeat(1200);
    const text = `${para1}\n\n${para2}`;
    // text.length = 2402; limit = 2000
    // lastIndexOf('\n\n', 2000) = 1200 → 1200 >= 500 → use 1200
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBe(2);
    // chunk[0] = substring(0, 1200) = para1; chunk[1] = para2 (trimStart removes the \n\n)
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it('falls back to \\n boundary when \\n\\n is too close to start (< 500)', () => {
    // Place \n\n very early (position 3, which is < 500) and a single \n later
    // (position 604, which is >= 500).
    // With limit=700: lastIndexOf('\n\n', 700) = 3 → < 500 threshold → falls back to \n
    //                 lastIndexOf('\n', 700) = 604 → 604 >= 500 → use 604
    const head = 'AB\n\n' + 'C'.repeat(600) + '\n' + 'D'.repeat(100);
    // Verify positions:  "AB\n\n" is 4 chars; \n\n at index 2; \n at index 604.
    const chunks = chunkText(head, 700);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toBe(head.substring(0, 604));
    expect(chunks[1]).toBe('D'.repeat(100));
  });

  it('hard-splits at limit when no suitable break point exists', () => {
    // No newlines at all in a long string.
    const text = 'A'.repeat(350);
    const chunks = chunkText(text, 100);
    // All pieces must be <= 100 chars.
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
    }
    // Reassembled (no trimStart effect since no newlines) should equal original.
    expect(chunks.join('')).toBe(text);
  });

  it('no chunk exceeds the limit in a multi-paragraph split', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(200)}`).join('\n\n');
    const chunks = chunkText(text, 500);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(500);
    }
  });

  it('handles exactly-limit-length text as a single chunk', () => {
    const text = 'X'.repeat(2000);
    const chunks = chunkText(text, 2000);
    expect(chunks).toEqual([text]);
  });
});
