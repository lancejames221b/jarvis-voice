import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { describeImage } from '../telegram/vision.js';

function okResponse(content) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

describe('describeImage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the image, posts an image_url block, and returns the description', async () => {
    const read = vi.fn().mockResolvedValue(Buffer.from('PNGBYTES'));
    const fetchMock = vi.fn().mockResolvedValue(okResponse('  a red square  '));
    const out = await describeImage('/tmp/pic.png', 'what is this', {
      read, fetch: fetchMock, baseUrl: 'http://lms:1234', model: 'qwen-vl',
    });
    expect(out).toBe('a red square');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://lms:1234/v1/chat/completions');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('qwen-vl');
    const blocks = body.messages[0].content;
    const img = blocks.find((b) => b.type === 'image_url');
    // base64 of "PNGBYTES" with the png mime derived from the .png extension
    expect(img.image_url.url).toBe(`data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`);
    // caption is woven into the text prompt as sender intent
    const textBlock = blocks.find((b) => b.type === 'text');
    expect(textBlock.text).toContain('what is this');
  });

  it('falls back to reasoning_content when content is empty', async () => {
    const read = vi.fn().mockResolvedValue(Buffer.from('x'));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '', reasoning_content: 'it is blue' } }] }),
    });
    const out = await describeImage('/tmp/p.jpg', '', { read, fetch: fetchMock });
    expect(out).toBe('it is blue');
  });

  it('derives image/jpeg for .jpg files', async () => {
    const read = vi.fn().mockResolvedValue(Buffer.from('J'));
    const fetchMock = vi.fn().mockResolvedValue(okResponse('ok'));
    await describeImage('/tmp/p.jpg', '', { read, fetch: fetchMock });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const img = body.messages[0].content.find((b) => b.type === 'image_url');
    expect(img.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('returns empty string when the file cannot be read', async () => {
    const read = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const fetchMock = vi.fn();
    const out = await describeImage('/tmp/missing.png', '', { read, fetch: fetchMock });
    expect(out).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty string on a non-ok HTTP response', async () => {
    const read = vi.fn().mockResolvedValue(Buffer.from('x'));
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const out = await describeImage('/tmp/p.png', '', { read, fetch: fetchMock });
    expect(out).toBe('');
  });

  it('returns empty string when fetch throws', async () => {
    const read = vi.fn().mockResolvedValue(Buffer.from('x'));
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const out = await describeImage('/tmp/p.png', '', { read, fetch: fetchMock });
    expect(out).toBe('');
  });
});
