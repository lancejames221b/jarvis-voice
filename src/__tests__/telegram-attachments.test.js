import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { buildAttachmentContext } from '../telegram/attachments.js';

describe('buildAttachmentContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('describes an image and includes the description + caption', async () => {
    const describe = vi.fn().mockResolvedValue('a cat on a keyboard');
    const out = await buildAttachmentContext(
      { kind: 'image', path: '/tmp/a.png', caption: 'who is this' },
      { describe },
    );
    expect(describe).toHaveBeenCalledWith('/tmp/a.png', 'who is this');
    expect(out).toContain('a cat on a keyboard');
    expect(out).toContain('who is this');
  });

  it('falls back to a path reference when vision returns nothing', async () => {
    const describe = vi.fn().mockResolvedValue('');
    const out = await buildAttachmentContext(
      { kind: 'image', path: '/tmp/a.png', caption: '' },
      { describe },
    );
    expect(out).toContain('/tmp/a.png');
    expect(out).toContain('description was unavailable');
  });

  it('inlines a small text document in a code fence', async () => {
    const read = vi.fn().mockResolvedValue(Buffer.from('hello=world\n'));
    const out = await buildAttachmentContext(
      { kind: 'document', path: '/proj/x.env', fileName: 'x.env', mimeType: 'text/plain', caption: null },
      { read },
    );
    expect(out).toContain('x.env');
    expect(out).toContain('```');
    expect(out).toContain('hello=world');
  });

  it('hands off a large text document by path instead of inlining', async () => {
    const big = Buffer.alloc(60_000, 0x61); // 60KB of 'a'
    const read = vi.fn().mockResolvedValue(big);
    const out = await buildAttachmentContext(
      { kind: 'document', path: '/proj/big.log', fileName: 'big.log', mimeType: 'text/plain', caption: null },
      { read },
    );
    expect(out).toContain('too large to inline');
    expect(out).toContain('/proj/big.log');
    expect(out).not.toContain('```');
  });

  it('hands off a non-text document (e.g. pdf) by path', async () => {
    const read = vi.fn();
    const out = await buildAttachmentContext(
      { kind: 'document', path: '/proj/report.pdf', fileName: 'report.pdf', mimeType: 'application/pdf', caption: 'read this' },
      { read },
    );
    expect(read).not.toHaveBeenCalled();
    expect(out).toContain('report.pdf');
    expect(out).toContain('/proj/report.pdf');
    expect(out).toContain('read this');
  });

  it('recognizes a text doc by extension when mime is missing', async () => {
    const read = vi.fn().mockResolvedValue(Buffer.from('console.log(1)'));
    const out = await buildAttachmentContext(
      { kind: 'document', path: '/proj/s.js', fileName: 's.js', mimeType: null, caption: null },
      { read },
    );
    expect(read).toHaveBeenCalled();
    expect(out).toContain('console.log(1)');
  });
});
