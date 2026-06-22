/**
 * comms-attachments.test.js
 *
 * Coverage for src/comms/attachments.js extractAttachmentsNeutral().
 * Mirrors the same scenarios as src/__tests__/attachments.test.js but
 * asserts on the NEUTRAL AgnosticFile shape (no AttachmentBuilder).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAttachmentsNeutral } from '../comms/attachments.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTempFile(name, content = 'hello') {
  const p = '/tmp/' + name;
  fs.writeFileSync(p, content);
  return fs.realpathSync(p);
}

function createHomeTempFile(name, content = 'secret') {
  const home = process.env.HOME || os.homedir();
  const p = path.join(home, '.jarvis-test-neutral', name);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content);
  return fs.realpathSync(p);
}

function cleanup(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch {}
  }
  try {
    const home = process.env.HOME || os.homedir();
    const d = path.join(home, '.jarvis-test-neutral');
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch {}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('extractAttachmentsNeutral', () => {
  it('returns a neutral AgnosticFile for an allowlisted /tmp image', () => {
    const tmpFile = createTempFile('neutral-shot.png');
    try {
      const text = `Here is the result:\n\n![screenshot](${tmpFile})\n\nLet me know.`;
      const result = extractAttachmentsNeutral(text);

      expect(result.files).toHaveLength(1);
      const f = result.files[0];
      expect(f.kind).toBe('image');
      expect(f.path).toBe(tmpFile);
      expect(f.name).toBe('neutral-shot.png');
      expect(f.mime).toBe('image/png');
      expect(result.cleanedText).not.toContain('![screenshot]');
      expect(result.cleanedText).toContain('Here is the result');
      expect(result.cleanedText).toContain('Let me know');
      expect(result.dropped).toHaveLength(0);
    } finally {
      cleanup(tmpFile);
    }
  });

  it('strips a bare /tmp path from cleanedText', () => {
    const tmpFile = createTempFile('neutral-bare.png');
    try {
      const text = `I generated this:\n\n${tmpFile}\n\nCheck it out.`;
      const result = extractAttachmentsNeutral(text);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('neutral-bare.png');
      expect(result.cleanedText).not.toContain(tmpFile);
      expect(result.dropped).toHaveLength(0);
    } finally {
      cleanup(tmpFile);
    }
  });

  it('drops a file outside the allowlist with reason outside-allowlist, text unchanged', () => {
    const homeFile = createHomeTempFile('secret.txt');
    try {
      const text = `See the private file at ${homeFile}`;
      const result = extractAttachmentsNeutral(text);

      expect(result.files).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0].reason).toBe('outside-allowlist');
      // Invariant: text unchanged when nothing is removed
      expect(result.cleanedText).toBe(text);
    } finally {
      cleanup(homeFile);
    }
  });

  it('rejects a ".." escape attempt (/tmp/../etc/passwd)', () => {
    const text = `Check this: /tmp/../etc/passwd`;
    const result = extractAttachmentsNeutral(text);

    const dropped = result.dropped.find((d) => d.path.includes('passwd'));
    expect(dropped).toBeDefined();
    expect(dropped.reason).toBe('outside-allowlist');
    expect(result.files).toHaveLength(0);
  });

  it('drops a non-existent path with reason not-found', () => {
    const text = `File not here: /tmp/does-not-exist-neutral-xyz.png`;
    const result = extractAttachmentsNeutral(text);

    const dropped = result.dropped.find((d) => d.path.includes('does-not-exist-neutral-xyz'));
    expect(dropped).toBeDefined();
    expect(dropped.reason).toBe('not-found');
    expect(result.files).toHaveLength(0);
  });

  it('drops an oversize file with reason too-large when maxBytes is tiny', () => {
    const tmpFile = createTempFile('neutral-big.txt', 'x'.repeat(1000));
    try {
      const text = `![big](${tmpFile})`;
      const result = extractAttachmentsNeutral(text, { maxBytes: 10 });

      const dropped = result.dropped.find((d) => d.path.includes('neutral-big.txt'));
      expect(dropped).toBeDefined();
      expect(dropped.reason).toBe('too-large');
      expect(result.files).toHaveLength(0);
    } finally {
      cleanup(tmpFile);
    }
  });

  it('respects maxFiles cap', () => {
    const f1 = createTempFile('n-one.png');
    const f2 = createTempFile('n-two.png');
    const f3 = createTempFile('n-three.png');
    try {
      const text = `Files:\n${f1}\n${f2}\n${f3}`;
      const result = extractAttachmentsNeutral(text, { maxFiles: 2 });

      expect(result.files).toHaveLength(2);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0].reason).toBe('max-files');
    } finally {
      cleanup(f1, f2, f3);
    }
  });

  it('returns empty result when no file paths are referenced', () => {
    const text = `Hello world, no files here at all.`;
    const result = extractAttachmentsNeutral(text);

    expect(result.cleanedText).toBe(text);
    expect(result.files).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it('no-paths invariant: cleanedText === input byte-for-byte (fenced block + blank lines)', () => {
    const input = `Hello

\`\`\`js
  const x = 1;
\`\`\`

Done.`;
    const result = extractAttachmentsNeutral(input);

    expect(result.cleanedText).toBe(input);
    expect(result.files).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it('allows custom allowDirs via opts', () => {
    const homeFile = createHomeTempFile('neutral-custom.txt', 'custom');
    try {
      const home = process.env.HOME || os.homedir();
      const text = `Custom: ${homeFile}`;
      const result = extractAttachmentsNeutral(text, { allowDirs: [home] });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('neutral-custom.txt');
      expect(result.dropped).toHaveLength(0);
    } finally {
      cleanup(homeFile);
    }
  });

  it('deduplicates identical paths referenced multiple ways', () => {
    const tmpFile = createTempFile('neutral-dedup.png');
    try {
      const text = `First: ${tmpFile}\n\n![alt](${tmpFile})`;
      const result = extractAttachmentsNeutral(text);

      expect(result.files).toHaveLength(1);
      expect(result.cleanedText).not.toContain(tmpFile);
      expect(result.cleanedText).not.toContain('![alt]');
    } finally {
      cleanup(tmpFile);
    }
  });

  it('drops directories with reason not-a-file', () => {
    const tmpDir = '/tmp/jarvis-neutral-test-dir';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const text = `Dir: ${tmpDir}`;
      const result = extractAttachmentsNeutral(text);

      const dropped = result.dropped.find((d) => d.path === tmpDir);
      expect(dropped).toBeDefined();
      expect(dropped.reason).toBe('not-a-file');
      expect(result.files).toHaveLength(0);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ── Kind-by-extension mapping ─────────────────────────────────────────────

  it('maps .mp3 to audio kind', () => {
    const tmpFile = createTempFile('neutral-sound.mp3');
    try {
      const result = extractAttachmentsNeutral(`${tmpFile}`);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].kind).toBe('audio');
      expect(result.files[0].mime).toBe('audio/mpeg');
    } finally {
      cleanup(tmpFile);
    }
  });

  it('maps .wav to audio kind', () => {
    const tmpFile = createTempFile('neutral-sound.wav');
    try {
      const result = extractAttachmentsNeutral(`${tmpFile}`);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].kind).toBe('audio');
    } finally {
      cleanup(tmpFile);
    }
  });

  it('maps .mp4 to video kind', () => {
    const tmpFile = createTempFile('neutral-clip.mp4');
    try {
      const result = extractAttachmentsNeutral(`${tmpFile}`);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].kind).toBe('video');
      expect(result.files[0].mime).toBe('video/mp4');
    } finally {
      cleanup(tmpFile);
    }
  });

  it('maps .pdf to doc kind', () => {
    const tmpFile = createTempFile('neutral-report.pdf');
    try {
      const result = extractAttachmentsNeutral(`${tmpFile}`);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].kind).toBe('doc');
      expect(result.files[0].mime).toBe('application/pdf');
    } finally {
      cleanup(tmpFile);
    }
  });

  it('maps .jpg to image kind', () => {
    const tmpFile = createTempFile('neutral-photo.jpg');
    try {
      const result = extractAttachmentsNeutral(`${tmpFile}`);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].kind).toBe('image');
      expect(result.files[0].mime).toBe('image/jpeg');
    } finally {
      cleanup(tmpFile);
    }
  });

  it('maps unknown extension to doc kind with undefined mime', () => {
    const tmpFile = createTempFile('neutral-data.xyz');
    try {
      const result = extractAttachmentsNeutral(`${tmpFile}`);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].kind).toBe('doc');
      expect(result.files[0].mime).toBeUndefined();
    } finally {
      cleanup(tmpFile);
    }
  });
});
