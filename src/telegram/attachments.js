/**
 * attachments.js — turn a downloaded Telegram attachment into prompt context.
 *
 * Mirrors the Discord _buildAttachmentContext model (src/index.js): images
 * become a vision description the text-only brain can reason over; small text
 * documents are inlined in a code fence; everything else is handed to the agent
 * as a saved file path it can open with its own tools.
 *
 * Pure and injectable: download/describe/read are passed in so the adapter owns
 * the side effects (download location, project binding) and this module stays
 * unit-testable.
 */
import { readFile } from 'fs/promises';
import { describeImage } from './vision.js';
import logger from '../logger.js';

// Inline text documents up to this size; larger ones are handed off by path.
// Matches the Discord path's _MAX_FILE_BYTES.
const MAX_INLINE_BYTES = 50_000;

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'js', 'mjs', 'cjs', 'ts',
  'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'bash',
  'zsh', 'html', 'css', 'scss', 'sql', 'toml', 'ini', 'cfg', 'conf', 'env',
  'log', 'csv', 'xml',
]);

function extOf(name = '') {
  return name.split('.').pop()?.toLowerCase() || '';
}

function isTextDoc(fileName, mimeType) {
  if (mimeType && (mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType === 'application/xml')) return true;
  return TEXT_EXTS.has(extOf(fileName));
}

/**
 * Build the prompt context block for one downloaded attachment.
 *
 * @param {object} att   { kind:'image'|'document', path, fileName, mimeType, caption }
 * @param {object} [deps] injectable for tests: { describe, read }
 * @returns {Promise<string>} a context block to append to the brain prompt ('' if nothing usable)
 */
export async function buildAttachmentContext(att, deps = {}) {
  const describe = deps.describe || describeImage;
  const read = deps.read || readFile;
  const caption = att.caption ? String(att.caption).trim() : '';

  if (att.kind === 'image') {
    const desc = await describe(att.path, caption);
    if (!desc) {
      // Vision failed — still tell the agent an image arrived and where it is,
      // so it can try its own tools rather than silently dropping it.
      return `\n\n[The user sent an image saved at ${att.path}`
        + (caption ? ` with caption: "${caption}"` : '')
        + `. Automatic visual description was unavailable.]`;
    }
    return `\n\n[The user sent an image. Here is a faithful description of what it shows:\n${desc}\n]`
      + (caption ? `\n[Image caption from the user: "${caption}"]` : '');
  }

  // Document: inline small text files, otherwise hand off by path.
  if (isTextDoc(att.fileName, att.mimeType)) {
    try {
      const buf = await read(att.path);
      if (buf.length <= MAX_INLINE_BYTES) {
        const text = Buffer.from(buf).toString('utf8');
        return `\n\n[File the user sent: ${att.fileName}]\n\`\`\`\n${text}\n\`\`\``
          + (caption ? `\n[Note from the user: "${caption}"]` : '');
      }
      return `\n\n[The user sent a file too large to inline: ${att.fileName} `
        + `(${buf.length} bytes), saved at ${att.path}. Open it with your tools if needed.]`
        + (caption ? `\n[Note from the user: "${caption}"]` : '');
    } catch (err) {
      logger.warn({ err: err.message, path: att.path }, '[telegram-attach] read failed');
      // fall through to the generic path reference
    }
  }

  return `\n\n[The user sent a file: ${att.fileName} (saved at ${att.path}). `
    + `Open it with your tools if you need its contents.]`
    + (caption ? `\n[Note from the user: "${caption}"]` : '');
}
