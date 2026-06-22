/**
 * src/comms/attachments.js — transport-neutral attachment extraction.
 *
 * extractAttachmentsNeutral(text, opts = {})
 *   returns: { cleanedText, files: AgnosticFile[], dropped: [{ path, reason }] }
 *
 * The full path-allowlist / realpath / containment validation from
 * src/discord/attachments.js is preserved VERBATIM — only the output shape
 * changes: AgnosticFile objects instead of discord.js AttachmentBuilder objects.
 *
 * This module intentionally imports NO surface-specific libraries.
 *
 * File reference formats recognised (same as discord/attachments.js):
 *   a. Markdown images:  ![alt](/abs/path.ext)  or  ![](file:///abs/path.ext)
 *   b. file:// URLs:     file:///abs/path.ext
 *   c. Bare absolute paths on their own line:  /abs/path.ext  or  ~/rel/path.ext
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a path string to a real absolute path, expanding ~ and following symlinks.
 * Returns null on any failure.
 */
function resolvePath(raw) {
  try {
    let p = raw;
    if (p.startsWith('~/')) {
      const home = process.env.HOME || os.homedir();
      p = path.join(home, p.slice(2));
    }
    const abs = path.resolve(p);
    return fs.realpathSync(abs);
  } catch {
    return null;
  }
}

/**
 * Check whether resolvedPath is safely contained inside one of the allowDirs.
 * Uses realpath-resolved dirs and a strict containment check (no partial-prefix
 * matches — /tmp must NOT match /tmpfoo).
 */
function isInsideAllowlist(resolvedPath, allowDirs) {
  for (const dir of allowDirs) {
    if (resolvedPath === dir || resolvedPath.startsWith(dir + path.sep)) {
      return true;
    }
  }
  return false;
}

/**
 * Build an allowDirs array from the opts and env var, realpath-resolved.
 */
function buildAllowDirs(optsAllowDirs) {
  const dirs = new Set();
  const defaultDirs = ['/tmp'];

  if (process.env.JARVIS_ATTACH_DIRS) {
    for (const raw of process.env.JARVIS_ATTACH_DIRS.split(':')) {
      const trimmed = raw.trim();
      if (trimmed) defaultDirs.push(trimmed);
    }
  }

  if (optsAllowDirs && optsAllowDirs.length) {
    for (const d of optsAllowDirs) {
      defaultDirs.push(d);
    }
  }

  for (const raw of defaultDirs) {
    try {
      let p = raw;
      if (p.startsWith('~/')) {
        const home = process.env.HOME || os.homedir();
        p = path.join(home, p.slice(2));
      }
      const resolved = fs.realpathSync(path.resolve(p));
      if (resolved) dirs.add(resolved);
    } catch {
      // silently skip non-existent entries
    }
  }

  return [...dirs];
}

/**
 * Derive an AgnosticFile kind from a file extension.
 *
 * @param {string} name - filename (basename)
 * @returns {'image'|'audio'|'video'|'doc'}
 */
function kindFromName(name) {
  const ext = path.extname(name).toLowerCase().slice(1); // strip leading dot
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
  return 'doc';
}

/**
 * Best-effort MIME type from extension.
 *
 * @param {string} name - filename (basename)
 * @returns {string|undefined}
 */
function mimeFromName(name) {
  const ext = path.extname(name).toLowerCase().slice(1);
  const MAP = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    pdf: 'application/pdf',
    txt: 'text/plain',
  };
  return MAP[ext];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract file references from text, validate against an allowlist, and return
 * neutral AgnosticFile objects plus cleaned text.
 *
 * The security validation (realpathSync symlink-follow, strict allowlist
 * containment, JARVIS_ATTACH_DIRS, size/count caps) is identical to
 * src/discord/attachments.js — only the output shape changes.
 *
 * Invariant: when no paths are removed, cleanedText === text byte-for-byte.
 *
 * @param {string} text — the full message text
 * @param {object} [opts]
 * @param {string[]} [opts.allowDirs] — extra allowlist dirs (resolved via realpath)
 * @param {number}   [opts.maxFiles]  — max files to attach (default 10)
 * @param {number}   [opts.maxBytes]  — max file size in bytes (default 8 MB)
 * @param {string}   [opts.cwd]       — current working dir (reserved, unused)
 * @returns {{ cleanedText: string, files: import('../comms/types.js').AgnosticFile[], dropped: Array<{ path: string, reason: string }> }}
 */
export function extractAttachmentsNeutral(text, opts = {}) {
  const {
    allowDirs: optsAllowDirs,
    maxFiles = 10,
    maxBytes = 8 * 1024 * 1024,
  } = opts;

  const allowList = buildAllowDirs(optsAllowDirs);
  const files = [];
  const dropped = [];
  const acceptedPaths = new Set();
  const notFoundPaths = new Set(); // paths that exist syntactically but not on disk
  const removals = []; // { start, end } ranges to remove from text

  // ── Pass 1: find all file references ──────────────────────────────────────

  const tryAddPath = (raw) => {
    const resolved = resolvePath(raw);
    if (resolved) {
      acceptedPaths.add(resolved);
      return;
    }
    // Path doesn't exist on disk — track as not-found for valid-looking paths
    try {
      let p = raw;
      if (p.startsWith('~/')) {
        const home = process.env.HOME || os.homedir();
        p = path.join(home, p.slice(2));
      }
      const abs = path.resolve(p);
      if (fs.existsSync(abs)) {
        acceptedPaths.add(abs);
      } else {
        notFoundPaths.add(abs);
      }
    } catch {
      // not a valid path at all — ignore silently
    }
  };

  // a. Markdown image links: ![alt](/abs/path) or ![](file:///abs/path)
  for (const m of text.matchAll(/!\[.*?\]\((file:\/\/|)(\/[^)]+)\)/gs)) {
    const raw = m[2];
    tryAddPath(raw);
  }

  // c. file:// URLs (not already captured by markdown)
  for (const m of text.matchAll(/file:\/\/(\/[^ )\n]+)/g)) {
    const raw = m[1];
    if (text.slice(Math.max(0, m.index - 3), m.index).includes('![')) continue;
    tryAddPath(raw);
  }

  // b. Bare absolute paths — standalone / or ~ paths
  for (const m of text.matchAll(/(?:^|(?<=\s))(\/[^ )\n]+)(?=\s|$)/gm)) {
    const raw = m[1];
    if (text.slice(0, m.index).split('![').length > text.slice(0, m.index).split(']').length) continue;
    if (raw.startsWith('file://')) continue;
    tryAddPath(raw);
  }

  // ── Pass 2: validate accepted paths ───────────────────────────────────────

  for (const resolvedPath of acceptedPaths) {
    if (!isInsideAllowlist(resolvedPath, allowList)) {
      dropped.push({ path: resolvedPath, reason: 'outside-allowlist' });
      continue;
    }
    let stat;
    try { stat = fs.statSync(resolvedPath); } catch {
      dropped.push({ path: resolvedPath, reason: 'not-found' });
      continue;
    }
    if (!stat.isFile()) {
      dropped.push({ path: resolvedPath, reason: 'not-a-file' });
      continue;
    }
    if (stat.size > maxBytes) {
      dropped.push({ path: resolvedPath, reason: 'too-large' });
      continue;
    }
  }

  // ── Pass 3: build AgnosticFile objects and collect removal ranges ──────────

  const finalAccepted = new Set();
  let fileCount = 0;

  const isDropped = (p) => dropped.find((d) => d.path === p);

  // Markdown image links
  for (const m of text.matchAll(/!\[.*?\]\((file:\/\/|)(\/[^)]+)\)/gs)) {
    const raw = m[2];
    const resolved = resolvePath(raw);
    if (resolved && acceptedPaths.has(resolved) && !isDropped(resolved)) {
      if (fileCount >= maxFiles) { dropped.push({ path: resolved, reason: 'max-files' }); continue; }
      finalAccepted.add(resolved);
      removals.push({ start: m.index, end: m.index + m[0].length });
      const name = path.basename(resolved);
      files.push({ kind: kindFromName(name), path: resolved, name, mime: mimeFromName(name) });
      fileCount++;
    }
  }

  // file:// URLs (not in markdown)
  for (const m of text.matchAll(/file:\/\/(\/[^ )\n]+)/g)) {
    const raw = m[1];
    if (text.slice(Math.max(0, m.index - 3), m.index).includes('![')) continue;
    const resolved = resolvePath(raw);
    if (resolved && acceptedPaths.has(resolved) && !isDropped(resolved) && !finalAccepted.has(resolved)) {
      if (fileCount >= maxFiles) { dropped.push({ path: resolved, reason: 'max-files' }); continue; }
      finalAccepted.add(resolved);
      removals.push({ start: m.index, end: m.index + m[0].length });
      const name = path.basename(resolved);
      files.push({ kind: kindFromName(name), path: resolved, name, mime: mimeFromName(name) });
      fileCount++;
    }
  }

  // Bare paths — strip ALL references to accepted files (even if already accepted via another form)
  for (const m of text.matchAll(/(?:^|(?<=\s))(\/[^ )\n]+)(?=\s|$)/gm)) {
    const raw = m[1];
    if (text.slice(0, m.index).split('![').length > text.slice(0, m.index).split(']').length) continue;
    if (raw.startsWith('file://')) continue;
    const resolved = resolvePath(raw);
    if (resolved && acceptedPaths.has(resolved) && !isDropped(resolved)) {
      removals.push({ start: m.index, end: m.index + raw.length });
      if (!finalAccepted.has(resolved)) {
        if (fileCount >= maxFiles) { dropped.push({ path: resolved, reason: 'max-files' }); continue; }
        finalAccepted.add(resolved);
        const name = path.basename(resolved);
        files.push({ kind: kindFromName(name), path: resolved, name, mime: mimeFromName(name) });
        fileCount++;
      }
    }
  }

  // Add not-found paths to dropped
  for (const nf of notFoundPaths) {
    if (!dropped.find((d) => d.path === nf)) {
      dropped.push({ path: nf, reason: 'not-found' });
    }
  }

  // ── Pass 4: build cleaned text ────────────────────────────────────────────

  let cleaned = text;

  if (removals.length > 0) {
    // Splice out removal ranges (descending order = indices stay valid)
    removals.sort((a, b) => b.start - a.start);
    for (const r of removals) {
      cleaned = cleaned.slice(0, r.start) + cleaned.slice(r.end);
    }
    // Minimal cleanup: only fix the damage the splices caused.
    // 1. Strip trailing whitespace on any line that had a path removed.
    // 2. Collapse runs of 3+ newlines down to 2 (don't obliterate intentional blank lines).
    // 3. Trim a single leading/trailing newline pair so the message doesn't start with a gap.
    cleaned = cleaned.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
    if (cleaned.startsWith('\n\n')) cleaned = cleaned.slice(2);
    if (cleaned.endsWith('\n\n')) cleaned = cleaned.slice(0, -2);
  }
  // If removals is empty, cleaned === text — byte-for-byte preserved.

  return { cleanedText: cleaned, files, dropped };
}
