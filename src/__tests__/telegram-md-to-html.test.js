import { describe, it, expect } from 'vitest';
import { mdToTelegramHtml, mdToPlainText } from '../telegram/md-to-html.js';

describe('mdToTelegramHtml', () => {
  it('escapes HTML special chars in plain text', () => {
    expect(mdToTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('converts bold and italic', () => {
    expect(mdToTelegramHtml('**bold**')).toBe('<b>bold</b>');
    expect(mdToTelegramHtml('_em_')).toBe('<i>em</i>');
    expect(mdToTelegramHtml('*em*')).toBe('<i>em</i>');
  });

  it('converts inline code and escapes its contents', () => {
    expect(mdToTelegramHtml('use `a < b`')).toBe('use <code>a &lt; b</code>');
  });

  it('converts a fenced code block with a language class', () => {
    const out = mdToTelegramHtml('```js\nconst x = 1 < 2;\n```');
    expect(out).toContain('<pre><code class="language-js">const x = 1 &lt; 2;</code></pre>');
  });

  it('converts a fenced code block without a language', () => {
    const out = mdToTelegramHtml('```\nplain & <code>\n```');
    expect(out).toContain('<pre>plain &amp; &lt;code&gt;</pre>');
  });

  it('does NOT format markdown inside code', () => {
    // **bold** inside a code span must stay literal, not become a tag
    expect(mdToTelegramHtml('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('converts links to <a href>', () => {
    expect(mdToTelegramHtml('[docs](https://example.com/x)'))
      .toBe('<a href="https://example.com/x">docs</a>');
  });

  it('renders headers as a bold line', () => {
    expect(mdToTelegramHtml('## Setup')).toBe('<b>Setup</b>');
  });

  it('renders bullets with a bullet glyph', () => {
    expect(mdToTelegramHtml('- one\n- two')).toBe('• one\n• two');
  });

  it('neutralizes raw HTML in the source (no injection)', () => {
    // a user/agent emitting a raw <script> must be escaped, not passed through
    expect(mdToTelegramHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('returns empty string for blank input', () => {
    expect(mdToTelegramHtml('')).toBe('');
    expect(mdToTelegramHtml('   ')).toBe('');
  });
});

describe('mdToPlainText', () => {
  it('strips bold/italic/code markers', () => {
    expect(mdToPlainText('**b** and _i_ and `c`')).toBe('b and i and c');
  });
  it('strips headers and converts bullets', () => {
    expect(mdToPlainText('# Title\n- a\n- b')).toBe('Title\n• a\n• b');
  });
  it('renders links as text (url)', () => {
    expect(mdToPlainText('[docs](https://x.io)')).toBe('docs (https://x.io)');
  });
  it('unwraps fenced code', () => {
    expect(mdToPlainText('```\ncode\n```')).toBe('code');
  });
});
