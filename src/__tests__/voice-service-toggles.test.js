import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Voice Service Toggle Tests
 *
 * Tests for the JARVIS_STT_ENABLED, JARVIS_TTS_CHATTERBOX_ENABLED, and
 * JARVIS_TTS_KOKORO_ENABLED env-var toggles.
 *
 * The toggle constants are read at module import time in stt.js/tts.js, so we
 * use vi.resetModules() + dynamic import to force re-evaluation with each
 * process.env configuration.
 */

// ── Common mocks (must be called before module import) ───────────────────────
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@deepgram/sdk', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('dotenv/config', () => ({}));
vi.mock('fs', () => ({
  createReadStream: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('util', () => ({ promisify: vi.fn((fn) => vi.fn()) }));
vi.mock('path', async () => {
  const actual = await vi.importActual('path');
  return actual;
});

// ── STT toggle tests ─────────────────────────────────────────────────────────
describe('JARVIS_STT_ENABLED', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.JARVIS_STT_ENABLED = process.env.JARVIS_STT_ENABLED;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedEnv.JARVIS_STT_ENABLED === undefined) {
      delete process.env.JARVIS_STT_ENABLED;
    } else {
      process.env.JARVIS_STT_ENABLED = savedEnv.JARVIS_STT_ENABLED;
    }
    vi.resetModules();
  });

  it('transcribeAudio() returns empty result when JARVIS_STT_ENABLED=false', async () => {
    process.env.JARVIS_STT_ENABLED = 'false';
    const stt = await import('../stt.js');
    const result = await stt.transcribeAudio('/fake/path.wav');
    expect(result.text).toBe('');
    expect(result.rejected).toBe('stt_disabled');
  });

  it('getSTTHealth() reports disabled when JARVIS_STT_ENABLED=false', async () => {
    process.env.JARVIS_STT_ENABLED = 'false';
    const stt = await import('../stt.js');
    const health = stt.getSTTHealth();
    expect(health).toContain('disabled');
    expect(health).toContain('JARVIS_STT_ENABLED=false');
  });

  it('getSTTHealth() returns provider name when enabled (default)', async () => {
    delete process.env.JARVIS_STT_ENABLED; // default = enabled
    process.env.STT_PROVIDER = 'faster-whisper';
    const stt = await import('../stt.js');
    const health = stt.getSTTHealth();
    expect(health).not.toContain('disabled');
  });
});

// ── TTS Chatterbox toggle tests ───────────────────────────────────────────────
describe('JARVIS_TTS_CHATTERBOX_ENABLED', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.JARVIS_TTS_CHATTERBOX_ENABLED = process.env.JARVIS_TTS_CHATTERBOX_ENABLED;
    savedEnv.TTS_PROVIDER = process.env.TTS_PROVIDER;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedEnv.JARVIS_TTS_CHATTERBOX_ENABLED === undefined) {
      delete process.env.JARVIS_TTS_CHATTERBOX_ENABLED;
    } else {
      process.env.JARVIS_TTS_CHATTERBOX_ENABLED = savedEnv.JARVIS_TTS_CHATTERBOX_ENABLED;
    }
    if (savedEnv.TTS_PROVIDER === undefined) {
      delete process.env.TTS_PROVIDER;
    } else {
      process.env.TTS_PROVIDER = savedEnv.TTS_PROVIDER;
    }
    vi.resetModules();
  });

  it('getTTSHealth() reports chatterbox disabled when JARVIS_TTS_CHATTERBOX_ENABLED=false', async () => {
    process.env.JARVIS_TTS_CHATTERBOX_ENABLED = 'false';
    process.env.TTS_PROVIDER = 'chatterbox';
    const tts = await import('../tts.js');
    const health = tts.getTTSHealth();
    expect(health).toContain('DISABLED');
    expect(health).toContain('JARVIS_TTS_CHATTERBOX_ENABLED=false');
  });

  it('getTTSHealth() does not show disabled when JARVIS_TTS_CHATTERBOX_ENABLED=true', async () => {
    process.env.JARVIS_TTS_CHATTERBOX_ENABLED = 'true';
    process.env.TTS_PROVIDER = 'chatterbox';
    const tts = await import('../tts.js');
    const health = tts.getTTSHealth();
    expect(health).not.toContain('DISABLED');
  });

  it('synthesizeChatterboxStream() returns early when disabled', async () => {
    process.env.JARVIS_TTS_CHATTERBOX_ENABLED = 'false';
    const tts = await import('../tts.js');
    const onFile = vi.fn();
    // Should return without calling onFile (disabled path returns undefined immediately)
    await tts.synthesizeChatterboxStream('Hello.', onFile);
    expect(onFile).not.toHaveBeenCalled();
  });
});

// ── TTS Kokoro toggle tests ───────────────────────────────────────────────────
describe('JARVIS_TTS_KOKORO_ENABLED', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.JARVIS_TTS_KOKORO_ENABLED = process.env.JARVIS_TTS_KOKORO_ENABLED;
    savedEnv.TTS_PROVIDER = process.env.TTS_PROVIDER;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedEnv.JARVIS_TTS_KOKORO_ENABLED === undefined) {
      delete process.env.JARVIS_TTS_KOKORO_ENABLED;
    } else {
      process.env.JARVIS_TTS_KOKORO_ENABLED = savedEnv.JARVIS_TTS_KOKORO_ENABLED;
    }
    if (savedEnv.TTS_PROVIDER === undefined) {
      delete process.env.TTS_PROVIDER;
    } else {
      process.env.TTS_PROVIDER = savedEnv.TTS_PROVIDER;
    }
    vi.resetModules();
  });

  it('getTTSHealth() reports kokoro disabled when JARVIS_TTS_KOKORO_ENABLED=false', async () => {
    process.env.JARVIS_TTS_KOKORO_ENABLED = 'false';
    process.env.TTS_PROVIDER = 'kokoro';
    const tts = await import('../tts.js');
    const health = tts.getTTSHealth();
    expect(health).toContain('DISABLED');
    expect(health).toContain('JARVIS_TTS_KOKORO_ENABLED=false');
  });

  it('getTTSHealth() does not show disabled when JARVIS_TTS_KOKORO_ENABLED=true', async () => {
    process.env.JARVIS_TTS_KOKORO_ENABLED = 'true';
    process.env.TTS_PROVIDER = 'kokoro';
    const tts = await import('../tts.js');
    const health = tts.getTTSHealth();
    expect(health).not.toContain('DISABLED');
  });

  it('synthesizeKokoroStream() returns early when disabled', async () => {
    process.env.JARVIS_TTS_KOKORO_ENABLED = 'false';
    const tts = await import('../tts.js');
    const onFile = vi.fn();
    await tts.synthesizeKokoroStream('Hello.', onFile);
    expect(onFile).not.toHaveBeenCalled();
  });
});
