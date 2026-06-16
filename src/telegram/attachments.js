/**
 * attachments.js — turn a downloaded Telegram attachment into prompt context.
 *
 * The agent runs as `claude -p`, and the Claude CLI reads files referenced with
 * an "@<path>" token in the prompt as native input — including images (real
 * multimodal vision, not a text description) and documents (text, PDF, etc.).
 * So instead of describing the attachment with a separate model, we just save it
 * to disk and hand the agent an absolute @path. The agent sees the actual file.
 *
 * Absolute paths only: the gateway spawns `claude -p` with no explicit cwd, so a
 * relative @path would resolve against the gateway's directory, not where we
 * saved the file. The adapter always passes the absolute saved path.
 *
 * Pure: the adapter owns the download (location, project binding); this module
 * just shapes the prompt text, so it stays trivially unit-testable.
 */

/**
 * Build the prompt context block for one downloaded attachment.
 *
 * @param {object} att   { kind:'image'|'document', path, fileName, caption }
 *   path MUST be absolute (see module note).
 * @returns {string} a context block to append to the brain prompt
 */
export function buildAttachmentContext(att) {
  const caption = att.caption ? String(att.caption).trim() : '';
  const ref = `@${att.path}`;
  const noun = att.kind === 'image' ? 'image' : 'file';
  // The @ref lets the agent open the file with its own vision/read. We name the
  // kind and surface the caption so the agent knows the user's intent.
  let ctx = `\n\n[The user sent ${att.kind === 'image' ? 'an image' : 'a file'}`
    + (att.fileName ? ` (${att.fileName})` : '')
    + `. Open it with: ${ref}]`;
  if (caption) ctx += `\n[The user's note about this ${noun}: "${caption}"]`;
  return ctx;
}
