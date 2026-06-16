/**
 * format.js — shape an agent reply for Telegram delivery.
 *
 * The agent writes Discord-flavored Markdown; Telegram renders that raw unless
 * we convert it. renderReply() returns BOTH a rich-HTML rendering (for
 * parse_mode:'HTML') and a plain-text rendering (the fallback used when a rich
 * send is rejected), each pre-split into Telegram's 4096-char message limit.
 *
 * Chunking happens on the SOURCE markdown (then each chunk is rendered), and we
 * split on paragraph/line boundaries so we never cut through a code fence or an
 * HTML tag. The cap is conservative (3500) because HTML tags expand the rendered
 * length beyond the source.
 */
import { mdToTelegramHtml, mdToPlainText } from './md-to-html.js';

const TG_MAX = 4096;
const CHUNK_SRC_MAX = 3500; // leave headroom for HTML tag expansion

// Split source markdown into <=CHUNK_SRC_MAX pieces on safe boundaries
// (blank lines first, then single newlines, then hard slice as a last resort).
// Code fences are kept whole so a ``` block is never split across messages.
function splitSource(text) {
  if (text.length <= CHUNK_SRC_MAX) return [text];

  // Tokenize into fence-blocks and non-fence text so we never split inside a fence.
  const tokens = [];
  const re = /```[\s\S]*?```/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) tokens.push({ fence: false, s: text.slice(last, m.index) });
    tokens.push({ fence: true, s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ fence: false, s: text.slice(last) });

  const chunks = [];
  let cur = '';
  const flush = () => { if (cur) { chunks.push(cur); cur = ''; } };
  const pushPiece = (piece) => {
    if (cur.length + piece.length <= CHUNK_SRC_MAX) { cur += piece; return; }
    flush();
    if (piece.length <= CHUNK_SRC_MAX) { cur = piece; return; }
    // Oversized single piece (huge fence or paragraph): hard-slice it.
    for (let i = 0; i < piece.length; i += CHUNK_SRC_MAX) chunks.push(piece.slice(i, i + CHUNK_SRC_MAX));
  };

  for (const t of tokens) {
    if (t.fence) { pushPiece(t.s); continue; }
    // Split non-fence text on blank lines, then re-pack into chunks.
    const paras = t.s.split(/\n{2,}/);
    for (let i = 0; i < paras.length; i++) {
      const piece = paras[i] + (i < paras.length - 1 ? '\n\n' : '');
      pushPiece(piece);
    }
  }
  flush();
  return chunks.filter((c) => c.trim());
}

// Guard: an HTML chunk must still fit Telegram's hard 4096 limit after rendering.
// If a rendered chunk overflows (rare, tag-heavy), fall back to slicing it.
function capHtml(chunks) {
  const out = [];
  for (const c of chunks) {
    if (c.length <= TG_MAX) { out.push(c); continue; }
    for (let i = 0; i < c.length; i += TG_MAX) out.push(c.slice(i, i + TG_MAX));
  }
  return out;
}

/**
 * Render an agent reply for Telegram.
 * @param {string} fullText  the agent's raw markdown answer
 * @returns {{ html: string[], plain: string[] }} pre-chunked renderings
 */
export function renderReply(fullText) {
  const text = String(fullText ?? '').trim();
  if (!text) return { html: ['(no output)'], plain: ['(no output)'] };
  const sources = splitSource(text);
  return {
    html: capHtml(sources.map((s) => mdToTelegramHtml(s))),
    plain: sources.map((s) => mdToPlainText(s)).map((s) => s.slice(0, TG_MAX)),
  };
}
