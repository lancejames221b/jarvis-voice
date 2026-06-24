import { describe, it, expect } from 'vitest';

import { buildAttachmentContext } from '../telegram/attachments.js';

describe('buildAttachmentContext', () => {
  it('references an image by @<abs-path> so claude -p reads it as vision input', () => {
    const out = buildAttachmentContext({ kind: 'image', path: '/tmp/a.png', caption: 'who is this' });
    expect(out).toContain('@/tmp/a.png');
    expect(out).toMatch(/sent an image/i);
    expect(out).toContain('who is this');
  });

  it('references a document by @<abs-path> with its filename', () => {
    const out = buildAttachmentContext({
      kind: 'document', path: '/proj/report.pdf', fileName: 'report.pdf', caption: 'read this',
    });
    expect(out).toContain('@/proj/report.pdf');
    expect(out).toContain('report.pdf');
    expect(out).toMatch(/sent a file/i);
    expect(out).toContain('read this');
  });

  it('omits the note line when there is no caption', () => {
    const out = buildAttachmentContext({ kind: 'image', path: '/tmp/a.png', caption: null });
    expect(out).toContain('@/tmp/a.png');
    expect(out).not.toMatch(/note about/i);
  });

  it('still produces a usable @ref when fileName is missing', () => {
    const out = buildAttachmentContext({ kind: 'document', path: '/proj/x.bin', caption: '' });
    expect(out).toContain('@/proj/x.bin');
  });
});
