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


// ── Service Control tests ─────────────────────────────────────────────────────
describe('applyServiceToggles — service-control.js', () => {
  let execMock;

  beforeEach(() => {
    vi.resetModules();
    // Re-mock child_process.exec for each test so we can capture calls
    execMock = vi.fn();
    vi.doMock('child_process', () => ({ exec: execMock }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.JARVIS_STT_ENABLED;
    delete process.env.JARVIS_TTS_CHATTERBOX_ENABLED;
    delete process.env.JARVIS_TTS_KOKORO_ENABLED;
    delete process.env.JARVIS_STT_SYSTEMD_UNIT;
    delete process.env.JARVIS_TTS_CHATTERBOX_SYSTEMD_UNIT;
    delete process.env.JARVIS_TTS_KOKORO_DOCKER_NAME;
  });

  /**
   * Helper: configure execMock so that `sudo -n true` succeeds (so NOPASSWD
   * check passes) and `is-active` returns 'active' (so stop is attempted),
   * then the stop command itself succeeds.
   */
  function mockSudoAvailableAndActive() {
    execMock.mockImplementation((cmd, _opts, cb) => {
      if (cmd === 'sudo -n true') return cb(null, '', '');
      if (cmd.includes('is-active')) return cb(null, 'active', '');
      if (cmd === 'sudo -n systemctl stop whisper-service.service') return cb(null, '', '');
      cb(null, '', '');
    });
  }

  it('does nothing when all services are enabled (default)', async () => {
    // All defaults = true, no exec calls expected beyond the initial is-active checks
    // actually no exec calls at all since the code returns early
    execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
    const sc = await import('../service-control.js');
    await sc.applyServiceToggles();
    // No systemctl stop or docker stop should be called
    const stopCalls = execMock.mock.calls.filter(c => c[0].includes('stop'));
    expect(stopCalls).toHaveLength(0);
  });

  it('calls sudo systemctl stop for STT when JARVIS_STT_ENABLED=false', async () => {
    process.env.JARVIS_STT_ENABLED = 'false';
    mockSudoAvailableAndActive();
    const sc = await import('../service-control.js');
    await sc.applyServiceToggles();
    const stopCall = execMock.mock.calls.find(
      c => c[0] === 'sudo -n systemctl stop whisper-service.service'
    );
    expect(stopCall).toBeTruthy();
  });

  it('uses custom STT unit name from JARVIS_STT_SYSTEMD_UNIT env var', async () => {
    process.env.JARVIS_STT_ENABLED = 'false';
    process.env.JARVIS_STT_SYSTEMD_UNIT = 'my-whisper.service';
    execMock.mockImplementation((cmd, _opts, cb) => {
      if (cmd === 'sudo -n true') return cb(null, '', '');
      if (cmd.includes('is-active')) return cb(null, 'active', '');
      cb(null, '', '');
    });
    const sc = await import('../service-control.js');
    await sc.applyServiceToggles();
    const stopCall = execMock.mock.calls.find(
      c => c[0] === 'sudo -n systemctl stop my-whisper.service'
    );
    expect(stopCall).toBeTruthy();
  });

  it('does NOT call systemctl stop when sudo -n is unavailable, but does not throw', async () => {
    process.env.JARVIS_STT_ENABLED = 'false';
    execMock.mockImplementation((cmd, _opts, cb) => {
      if (cmd === 'sudo -n true') return cb(new Error('sudo: a password is required'), '', 'sudo: a password is required');
      cb(null, '', '');
    });
    const sc = await import('../service-control.js');
    // Should resolve without throwing even though sudo is unavailable
    await expect(sc.applyServiceToggles()).resolves.toBeUndefined();
    const stopCall = execMock.mock.calls.find(c => c[0].includes('systemctl stop'));
    expect(stopCall).toBeFalsy();
  });

  it('calls systemctl --user stop for Chatterbox when JARVIS_TTS_CHATTERBOX_ENABLED=false', async () => {
    process.env.JARVIS_TTS_CHATTERBOX_ENABLED = 'false';
    execMock.mockImplementation((cmd, _opts, cb) => {
      if (cmd.includes('is-active')) return cb(null, 'active', '');
      cb(null, '', '');
    });
    const sc = await import('../service-control.js');
    await sc.applyServiceToggles();
    const stopCall = execMock.mock.calls.find(
      c => c[0] === 'systemctl --user stop jarvis-chatterbox-tts.service'
    );
    expect(stopCall).toBeTruthy();
  });

  it('skips Chatterbox stop when unit is already inactive', async () => {
    process.env.JARVIS_TTS_CHATTERBOX_ENABLED = 'false';
    execMock.mockImplementation((cmd, _opts, cb) => {
      if (cmd.includes('is-active')) return cb(null, 'inactive', '');
      cb(null, '', '');
    });
    const sc = await import('../service-control.js');
    await sc.applyServiceToggles();
    const stopCall = execMock.mock.calls.find(
      c => c[0].includes('systemctl --user stop')
    );
    expect(stopCall).toBeFalsy();
  });

  it('calls systemctl --user stop for Kokoro when JARVIS_TTS_KOKORO_ENABLED=false', async () => {
    process.env.JARVIS_TTS_KOKORO_ENABLED = 'false';
    execMock.mockImplementation((cmd, _opts, cb) => {
      if (cmd.includes('is-active')) return cb(null, 'active', '');
      cb(null, '', '');
    });
    const sc = await import('../service-control.js');
    await sc.applyServiceToggles();
    const stopCall = execMock.mock.calls.find(
      c => c[0] === 'systemctl --user stop kokoro-tts.service'
    );
    expect(stopCall).toBeTruthy();
  });

  it('skips Kokoro stop when unit is already inactive', async () => {
    process.env.JARVIS_TTS_KOKORO_ENABLED = 'false';
    execMock.mockImplementation((cmd, _opts, cb) => {
      if (cmd.includes('is-active')) return cb(null, 'inactive', '');
      cb(null, '', '');
    });
    const sc = await import('../service-control.js');
    await sc.applyServiceToggles();
    const stopCall = execMock.mock.calls.find(
      c => c[0].includes('systemctl --user stop') && c[0].includes('kokoro')
    );
    expect(stopCall).toBeFalsy();
  });

  it('does not throw when systemctl --user stop fails for Kokoro', async () => {
    process.env.JARVIS_TTS_KOKORO_ENABLED = 'false';
    execMock.mockImplementation((cmd, _opts, cb) => {
      if (cmd.includes('is-active')) return cb(null, 'active', '');
      if (cmd.includes('systemctl --user stop kokoro')) {
        return cb(new Error('Unit kokoro-tts.service not found'), '', 'Unit not found');
      }
      cb(null, '', '');
    });
    const sc = await import('../service-control.js');
    await expect(sc.applyServiceToggles()).resolves.toBeUndefined();
  });

  it('exports SERVICE_UNITS with correct defaults', async () => {
    delete process.env.JARVIS_STT_SYSTEMD_UNIT;
    delete process.env.JARVIS_TTS_CHATTERBOX_SYSTEMD_UNIT;
    delete process.env.JARVIS_TTS_KOKORO_SYSTEMD_UNIT;
    const sc = await import('../service-control.js');
    expect(sc.SERVICE_UNITS.STT_UNIT).toBe('whisper-service.service');
    expect(sc.SERVICE_UNITS.CHATTERBOX_UNIT).toBe('jarvis-chatterbox-tts.service');
    expect(sc.SERVICE_UNITS.KOKORO_UNIT).toBe('kokoro-tts.service');
  });
});
