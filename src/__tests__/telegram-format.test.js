import { describe, it, expect } from 'vitest';
import { renderReply } from '../telegram/format.js';

describe('renderReply', () => {
  it('returns rich HTML and a plain-text fallback', () => {
    const out = renderReply('Done: **3 files** changed');
    expect(out.html[0]).toContain('<b>3 files</b>');
    expect(out.plain[0]).toContain('3 files');
    expect(out.plain[0]).not.toContain('**');
  });

  it('renders a fallback for empty text', () => {
    const out = renderReply('');
    expect(out.html).toEqual(['(no output)']);
    expect(out.plain).toEqual(['(no output)']);
  });

  it('keeps each HTML chunk within Telegram\'s 4096 limit', () => {
    const big = ('paragraph of text. '.repeat(40) + '\n\n').repeat(60); // ~48KB
    const out = renderReply(big);
    expect(out.html.length).toBeGreaterThan(1);
    out.html.forEach((c) => expect(c.length).toBeLessThanOrEqual(4096));
  });

  it('never splits a fenced code block across chunks', () => {
    const fence = '```\n' + 'x'.repeat(200) + '\n```';
    const filler = 'lorem ipsum dolor sit amet. '.repeat(200); // push past chunk size
    const out = renderReply(`${filler}\n\n${fence}`);
    // the fence must appear intact in exactly one chunk (balanced <pre>)
    const withPre = out.html.filter((c) => c.includes('<pre>'));
    expect(withPre.length).toBe(1);
    expect(withPre[0].match(/<pre>/g).length).toBe(withPre[0].match(/<\/pre>/g).length);
  });
});
