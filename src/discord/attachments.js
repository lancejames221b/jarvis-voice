/**
 * attachments.js — Discord attachment shim (Jarvis v2 §1.5).
 *
 * The path-allowlist / realpath / containment validation has moved verbatim to
 * src/comms/attachments.js (extractAttachmentsNeutral).  This module delegates
 * to that neutral layer and wraps the resulting AgnosticFile objects back into
 * discord.js AttachmentBuilder objects so that its two importers
 * (posting.js and message-handlers.js) keep receiving the IDENTICAL shape they
 * always have — no changes required at those call sites.
 *
 * Exported: extractAttachments(text, opts={})
 *   returns: { cleanedText, files: AttachmentBuilder[], dropped: [{ path, reason }] }
 */

import { AttachmentBuilder } from 'discord.js';
import { extractAttachmentsNeutral } from '../comms/attachments.js';

/**
 * Extract file references from text, validate against the allowlist, and
 * return discord.js AttachmentBuilder objects plus cleaned text.
 *
 * Behaviour is byte-for-byte identical to the previous implementation —
 * security properties, cleanedText output, dropped[] reasons, and
 * files.length are all preserved.
 *
 * @param {string} text — the full message text
 * @param {object} [opts]
 * @param {string[]} [opts.allowDirs] — allowlist dirs (resolved via realpath)
 * @param {number}   [opts.maxFiles]  — max files to attach (default 10)
 * @param {number}   [opts.maxBytes]  — max file size in bytes (default 8 MB)
 * @param {string}   [opts.cwd]       — current working dir (reserved)
 * @returns {{ cleanedText: string, files: import('discord.js').AttachmentBuilder[], dropped: Array<{ path: string, reason: string }> }}
 */
export function extractAttachments(text, opts = {}) {
  const { cleanedText, files, dropped } = extractAttachmentsNeutral(text, opts);
  return {
    cleanedText,
    dropped,
    files: files.map((f) =>
      f.path
        ? new AttachmentBuilder(f.path, { name: f.name })
        : new AttachmentBuilder(f.buffer, { name: f.name })
    ),
  };
}
