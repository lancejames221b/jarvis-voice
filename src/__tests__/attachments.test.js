import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractAttachments } from '../discord/attachments.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a temp file under /tmp and return its real path. */
function createTempFile(name, content = 'hello') {
  const p = '/tmp/' + name;
  fs.writeFileSync(p, content);
  return fs.realpathSync(p);
}

/** Create a temp file outside /tmp (under process.env.HOME) and return its real path. */
function createHomeTempFile(name, content = 'secret') {
  const home = process.env.HOME || os.homedir();
  const p = path.join(home, '.jarvis-test', name);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content);
  return fs.realpathSync(p);
}

/** Clean up test files. */
function cleanup(...paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch {}
  }
  // Clean up the home test dir
  try {
    const home = process.env.HOME || os.homedir();
    const d = path.join(home, '.jarvis-test');
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch {}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('extractAttachments', () => {
  it('attends a markdown image in /tmp, strips it from cleanedText', () => {
    const tmpFile = createTempFile('screenshot.png');
    try {
      const text = `Here is the result:\n\n![screenshot](${tmpFile})\n\nLet me know if you need anything.`;
      const result = extractAttachments(text);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('screenshot.png');
      expect(result.cleanedText).not.toContain('![screenshot]');
      expect(result.cleanedText).toContain('Here is the result');
      expect(result.cleanedText).toContain('Let me know');
      expect(result.dropped).toHaveLength(0);
    } finally {
      cleanup(tmpFile);
    }
  });

  it('attends a bare /tmp/x.png path on its own line, strips it', () => {
    const tmpFile = createTempFile('bare.png');
    try {
      const text = `I generated this:\n\n${tmpFile}\n\nCheck it out.`;
      const result = extractAttachments(text);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('bare.png');
      expect(result.cleanedText).not.toContain(tmpFile);
      expect(result.cleanedText).toContain('I generated this');
      expect(result.cleanedText).toContain('Check it out');
      expect(result.dropped).toHaveLength(0);
    } finally {
      cleanup(tmpFile);
    }
  });

  it('does NOT attach a file outside allowDirs, reason is outside-allowlist, text left intact', () => {
    const homeFile = createHomeTempFile('id_rsa');
    try {
      const text = `See the private key at ${homeFile}`;
      const result = extractAttachments(text);

      expect(result.files).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0].reason).toBe('outside-allowlist');
      // Text must be unchanged
      expect(result.cleanedText).toBe(text);
    } finally {
      cleanup(homeFile);
    }
  });

  it('rejects a ".." escape attempt (/tmp/../etc/passwd)', () => {
    // The realpath of /tmp/../etc/passwd is /etc/passwd which is NOT inside /tmp
    const text = `Check this: /tmp/../etc/passwd`;
    const result = extractAttachments(text);

    // It should be dropped (outside-allowlist since realpath resolves to /etc/passwd)
    const dropped = result.dropped.find(d => d.path.includes('passwd'));
    expect(dropped).toBeDefined();
    expect(dropped.reason).toBe('outside-allowlist');
    expect(result.files).toHaveLength(0);
  });

  it('drops a non-existent path with reason "not-found"', () => {
    const text = `File not here: /tmp/does-not-exist-xyz.png`;
    const result = extractAttachments(text);

    const dropped = result.dropped.find(d => d.path.includes('does-not-exist-xyz'));
    expect(dropped).toBeDefined();
    expect(dropped.reason).toBe('not-found');
    expect(result.files).toHaveLength(0);
  });

  it('drops an oversize file with reason "too-large" when maxBytes is tiny', () => {
    const tmpFile = createTempFile('big.txt', 'x'.repeat(1000));
    try {
      const text = `![big](${tmpFile})`;
      const result = extractAttachments(text, { maxBytes: 10 });

      const dropped = result.dropped.find(d => d.path.includes('big.txt'));
      expect(dropped).toBeDefined();
      expect(dropped.reason).toBe('too-large');
      expect(result.files).toHaveLength(0);
    } finally {
      cleanup(tmpFile);
    }
  });

  it('respects maxFiles cap', () => {
    const f1 = createTempFile('one.png');
    const f2 = createTempFile('two.png');
    const f3 = createTempFile('three.png');
    try {
      const text = `Files:\n${f1}\n${f2}\n${f3}`;
      const result = extractAttachments(text, { maxFiles: 2 });

      expect(result.files).toHaveLength(2);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0].reason).toBe('max-files');
    } finally {
      cleanup(f1, f2, f3);
    }
  });

  it('returns empty result when no file paths are referenced', () => {
    const text = `Hello world, no files here at all.`;
    const result = extractAttachments(text);

    expect(result.cleanedText).toBe(text);
    expect(result.files).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it('no paths preserves text exactly: fenced code block + blank lines intact', () => {
    const input = `Hello

\`\`\`js
  const x = 1;
\`\`\`

Done.`;
    const result = extractAttachments(input);

    expect(result.cleanedText).toBe(input);
    expect(result.files).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it('attachment strip preserves surrounding formatting', () => {
    const tmpFile = createTempFile('REALFILE.png');
    try {
      const text = `Here is the shot:

${tmpFile}

More text.`;
      const result = extractAttachments(text);

      expect(result.files).toHaveLength(1);
      expect(result.cleanedText).not.toContain(tmpFile);
      expect(result.cleanedText).toContain('Here is the shot');
      expect(result.cleanedText).toContain('More text');
      // Both lines should be present, not collapsed onto one line
      expect(result.cleanedText.split('\n').length).toBeGreaterThan(1);
      expect(result.dropped).toHaveLength(0);
    } finally {
      cleanup(tmpFile);
    }
  });

  it('handles file:// URLs', () => {
    const tmpFile = createTempFile('url-test.png');
    try {
      const text = `See file://${tmpFile}`;
      const result = extractAttachments(text);

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('url-test.png');
      expect(result.cleanedText).not.toContain('file://' + tmpFile);
      expect(result.dropped).toHaveLength(0);
    } finally {
      cleanup(tmpFile);
    }
  });

  it('handles ~/home-relative paths', () => {
    const home = process.env.HOME || os.homedir();
    const relPath = '.jarvis-test/tilde.png';
    const fullPath = path.join(home, relPath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, 'tilde content');
    const realPath = fs.realpathSync(fullPath);
    try {
      const text = `Check ${home}/.jarvis-test/tilde.png`;
      const result = extractAttachments(text);

      // The path starts with /home/... which is NOT in /tmp allowlist, so it should be dropped
      expect(result.files).toHaveLength(0);
      expect(result.dropped).toHaveLength(1);
      expect(result.dropped[0].reason).toBe('outside-allowlist');
    } finally {
      cleanup(realPath);
    }
  });

  it('allows custom allowDirs via opts', () => {
    const homeFile = createHomeTempFile('custom.txt', 'custom dir content');
    try {
      const text = `Custom: ${homeFile}`;
      const result = extractAttachments(text, {
        allowDirs: [process.env.HOME || os.homedir()],
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('custom.txt');
      expect(result.dropped).toHaveLength(0);
    } finally {
      cleanup(homeFile);
    }
  });

  it('deduplicates identical paths referenced multiple ways', () => {
    const tmpFile = createTempFile('dedup.png');
    try {
      const text = `First: ${tmpFile}\n\n![alt](${tmpFile})`;
      const result = extractAttachments(text);

      expect(result.files).toHaveLength(1);
      // Both references stripped
      expect(result.cleanedText).not.toContain(tmpFile);
      expect(result.cleanedText).not.toContain('![alt]');
    } finally {
      cleanup(tmpFile);
    }
  });

  it('drops directories with reason "not-a-file"', () => {
    const tmpDir = '/tmp/jarvis-test-dir';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const text = `Dir: ${tmpDir}`;
      const result = extractAttachments(text);

      const dropped = result.dropped.find(d => d.path === tmpDir);
      expect(dropped).toBeDefined();
      expect(dropped.reason).toBe('not-a-file');
      expect(result.files).toHaveLength(0);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});
