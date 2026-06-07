import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Module mocks (declared before any import) ─────────────────────────────────
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('dotenv/config', () => ({}));

// Mock fs so .env reads/writes are controlled in tests
vi.mock('fs', () => ({
  existsSync:    vi.fn(() => false),
  readFileSync:  vi.fn(() => ''),
  writeFileSync: vi.fn(),
  renameSync:    vi.fn(),
  mkdirSync:     vi.fn(),
}));

// Mock child_process — default: all commands succeed with empty output
let execMock = vi.fn((cmd, _opts, cb) => cb(null, '', ''));
vi.mock('child_process', () => ({
  get exec() { return execMock; },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
const ADMIN_ID     = '928436617159520338';
const NON_ADMIN_ID = '111111111111111111';

/** Build execMock that answers systemctl status queries correctly */
function makeExecMock({ sttActive = 'active', cbActive = 'active', kokoroActive = 'active', sudoOk = true } = {}) {
  return vi.fn((cmd, _opts, cb) => {
    if (cmd === 'sudo -n true') {
      return sudoOk ? cb(null, '', '') : cb(new Error('sudo: password required'), '', 'sudo: password required');
    }
    if (cmd.includes('is-active whisper'))     return cb(null, sttActive, '');
    if (cmd.includes('is-active jarvis-chat')) return cb(null, cbActive, '');
    if (cmd.includes('is-active kokoro'))      return cb(null, kokoroActive, '');
    if (cmd.includes('enable kokoro'))         return cb(null, '', '');
    if (cmd.includes('systemctl'))             return cb(null, '', '');
    if (cmd.includes('docker'))                return cb(null, '', '');
    return cb(null, '', '');
  });
}

// ── parseVoiceCommand ─────────────────────────────────────────────────────────
describe('parseVoiceCommand', () => {
  it('parses "voice off"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('voice off')).toEqual({ service: 'voice', action: 'off' });
  });

  it('parses "voice on"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('voice on')).toEqual({ service: 'voice', action: 'on' });
  });

  it('parses "voice status"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('voice status')).toEqual({ service: 'voice', action: 'status' });
  });

  it('parses "voice help"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('voice help')).toEqual({ service: 'voice', action: 'help' });
  });

  it('parses "stt off"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('stt off')).toEqual({ service: 'stt', action: 'off' });
  });

  it('parses "stt on"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('stt on')).toEqual({ service: 'stt', action: 'on' });
  });

  it('parses "tts off"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('tts off')).toEqual({ service: 'tts', action: 'off' });
  });

  it('parses "tts on"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('tts on')).toEqual({ service: 'tts', action: 'on' });
  });

  it('parses "chatterbox off"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('chatterbox off')).toEqual({ service: 'chatterbox', action: 'off' });
  });

  it('parses "chatterbox on"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('chatterbox on')).toEqual({ service: 'chatterbox', action: 'on' });
  });

  it('parses "kokoro off"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('kokoro off')).toEqual({ service: 'kokoro', action: 'off' });
  });

  it('parses "kokoro on"', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('kokoro on')).toEqual({ service: 'kokoro', action: 'on' });
  });

  it('is case-insensitive', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('Voice OFF')).toEqual({ service: 'voice', action: 'off' });
    expect(parseVoiceCommand('STT On')).toEqual({ service: 'stt', action: 'on' });
  });

  it('returns null for non-commands', async () => {
    vi.resetModules();
    const { parseVoiceCommand } = await import('../discord-voice-commands.js');
    expect(parseVoiceCommand('hello world')).toBeNull();
    expect(parseVoiceCommand('voice')).toBeNull();
    expect(parseVoiceCommand('voice restart')).toBeNull();
    expect(parseVoiceCommand('')).toBeNull();
  });
});

// ── isVoiceCmdAdmin ───────────────────────────────────────────────────────────
describe('isVoiceCmdAdmin', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.JARVIS_ADMIN_USER_IDS = process.env.JARVIS_ADMIN_USER_IDS;
    savedEnv.OWNER_USER_ID = process.env.OWNER_USER_ID;
    savedEnv.ALLOWED_USERS = process.env.ALLOWED_USERS;
    vi.resetModules();
  });

  afterEach(() => {
    Object.assign(process.env, savedEnv);
    vi.resetModules();
  });

  it('returns true for ID in JARVIS_ADMIN_USER_IDS', async () => {
    process.env.JARVIS_ADMIN_USER_IDS = ADMIN_ID;
    delete process.env.OWNER_USER_ID;
    delete process.env.ALLOWED_USERS;
    const { isVoiceCmdAdmin } = await import('../discord-voice-commands.js');
    expect(isVoiceCmdAdmin(ADMIN_ID)).toBe(true);
  });

  it('returns false for ID not in JARVIS_ADMIN_USER_IDS', async () => {
    process.env.JARVIS_ADMIN_USER_IDS = ADMIN_ID;
    delete process.env.OWNER_USER_ID;
    delete process.env.ALLOWED_USERS;
    const { isVoiceCmdAdmin } = await import('../discord-voice-commands.js');
    expect(isVoiceCmdAdmin(NON_ADMIN_ID)).toBe(false);
  });

  it('falls back to OWNER_USER_ID when JARVIS_ADMIN_USER_IDS unset', async () => {
    delete process.env.JARVIS_ADMIN_USER_IDS;
    process.env.OWNER_USER_ID = ADMIN_ID;
    const { isVoiceCmdAdmin } = await import('../discord-voice-commands.js');
    expect(isVoiceCmdAdmin(ADMIN_ID)).toBe(true);
    expect(isVoiceCmdAdmin(NON_ADMIN_ID)).toBe(false);
  });

  it('falls back to first ALLOWED_USERS when both other vars unset', async () => {
    delete process.env.JARVIS_ADMIN_USER_IDS;
    delete process.env.OWNER_USER_ID;
    process.env.ALLOWED_USERS = `${ADMIN_ID},${NON_ADMIN_ID}`;
    const { isVoiceCmdAdmin } = await import('../discord-voice-commands.js');
    // Only the first entry (owner) is treated as admin
    expect(isVoiceCmdAdmin(ADMIN_ID)).toBe(true);
    expect(isVoiceCmdAdmin(NON_ADMIN_ID)).toBe(false);
  });
});

// ── handleVoiceCommand — integration scenarios ────────────────────────────────
describe('handleVoiceCommand', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.JARVIS_ADMIN_USER_IDS = process.env.JARVIS_ADMIN_USER_IDS;
    savedEnv.JARVIS_STT_ENABLED = process.env.JARVIS_STT_ENABLED;
    savedEnv.JARVIS_TTS_CHATTERBOX_ENABLED = process.env.JARVIS_TTS_CHATTERBOX_ENABLED;
    savedEnv.JARVIS_TTS_KOKORO_ENABLED = process.env.JARVIS_TTS_KOKORO_ENABLED;
    process.env.JARVIS_ADMIN_USER_IDS = ADMIN_ID;
    vi.resetModules();
    execMock = makeExecMock();
    vi.doMock('child_process', () => ({ exec: execMock }));
  });

  afterEach(() => {
    Object.assign(process.env, savedEnv);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns null for non-admin sender (silently ignores)', async () => {
    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('voice off', NON_ADMIN_ID);
    expect(reply).toBeNull();
  });

  it('returns null for non-admin — no service-control calls fired', async () => {
    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    await handleVoiceCommand('voice off', NON_ADMIN_ID);
    const stopCalls = execMock.mock.calls.filter(c => c[0].includes('stop'));
    expect(stopCalls).toHaveLength(0);
  });

  it('returns null for content that is not a voice command', async () => {
    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('what is the capital of France', ADMIN_ID);
    expect(reply).toBeNull();
  });

  it('"voice off" fires all three stop commands and updates .env', async () => {
    execMock = makeExecMock({ sttActive: 'active', cbActive: 'active', kokoroActive: 'active' });
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('voice off', ADMIN_ID);

    // Should confirm all three stopped
    expect(reply).toMatch(/voice off/i);
    expect(reply).toMatch(/STT/i);
    expect(reply).toMatch(/Chatterbox/i);
    expect(reply).toMatch(/Kokoro/i);

    // systemctl stop should have been called for all three
    const stopCalls = execMock.mock.calls.filter(c => c[0].includes('stop'));
    expect(stopCalls.length).toBeGreaterThanOrEqual(3);

    // .env writeFileSync should have been called
    const { writeFileSync } = await import('fs');
    expect(writeFileSync).toHaveBeenCalled();

    // process.env should be updated
    expect(process.env.JARVIS_STT_ENABLED).toBe('false');
    expect(process.env.JARVIS_TTS_CHATTERBOX_ENABLED).toBe('false');
    expect(process.env.JARVIS_TTS_KOKORO_ENABLED).toBe('false');
  });

  it('"voice on" fires all three start commands and updates .env', async () => {
    execMock = makeExecMock({ sttActive: 'inactive', cbActive: 'inactive', kokoroActive: 'inactive' });
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('voice on', ADMIN_ID);

    expect(reply).toMatch(/voice on/i);

    const startCalls = execMock.mock.calls.filter(c => c[0].includes('start'));
    expect(startCalls.length).toBeGreaterThanOrEqual(3);

    expect(process.env.JARVIS_STT_ENABLED).toBe('true');
    expect(process.env.JARVIS_TTS_CHATTERBOX_ENABLED).toBe('true');
    expect(process.env.JARVIS_TTS_KOKORO_ENABLED).toBe('true');
  });

  it('"stt off" stops only whisper and persists JARVIS_STT_ENABLED=false', async () => {
    execMock = makeExecMock({ sttActive: 'active' });
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('stt off', ADMIN_ID);

    expect(reply).toMatch(/STT off/i);

    // Only whisper should be stopped
    const whisperStop = execMock.mock.calls.filter(c =>
      c[0].includes('stop') && c[0].includes('whisper')
    );
    expect(whisperStop.length).toBeGreaterThanOrEqual(1);

    // No chatterbox or kokoro stops
    const otherStop = execMock.mock.calls.filter(c =>
      c[0].includes('stop') && (c[0].includes('chatterbox') || c[0].includes('kokoro'))
    );
    expect(otherStop).toHaveLength(0);

    expect(process.env.JARVIS_STT_ENABLED).toBe('false');
  });

  it('"tts off" stops chatterbox and kokoro but not STT', async () => {
    execMock = makeExecMock({ cbActive: 'active', kokoroActive: 'active' });
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('tts off', ADMIN_ID);

    expect(reply).toMatch(/TTS off/i);

    const whisperStop = execMock.mock.calls.filter(c =>
      c[0].includes('stop') && c[0].includes('whisper')
    );
    expect(whisperStop).toHaveLength(0);

    const ttsStop = execMock.mock.calls.filter(c => c[0].includes('stop'));
    expect(ttsStop.length).toBeGreaterThanOrEqual(2);

    expect(process.env.JARVIS_TTS_CHATTERBOX_ENABLED).toBe('false');
    expect(process.env.JARVIS_TTS_KOKORO_ENABLED).toBe('false');
  });

  it('"chatterbox off" stops only chatterbox and persists', async () => {
    execMock = makeExecMock({ cbActive: 'active' });
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('chatterbox off', ADMIN_ID);

    expect(reply).toMatch(/Chatterbox off/i);

    const cbStop = execMock.mock.calls.filter(c =>
      c[0].includes('stop') && c[0].includes('chatterbox')
    );
    expect(cbStop.length).toBeGreaterThanOrEqual(1);

    expect(process.env.JARVIS_TTS_CHATTERBOX_ENABLED).toBe('false');
  });

  it('"kokoro on" enables and starts kokoro unit', async () => {
    execMock = makeExecMock({ kokoroActive: 'inactive' });
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('kokoro on', ADMIN_ID);

    expect(reply).toMatch(/Kokoro on/i);

    // Should have called enable first, then start
    const enableCall = execMock.mock.calls.find(c =>
      c[0].includes('enable') && c[0].includes('kokoro')
    );
    expect(enableCall).toBeTruthy();

    const startCall = execMock.mock.calls.find(c =>
      c[0].includes('start') && c[0].includes('kokoro')
    );
    expect(startCall).toBeTruthy();

    expect(process.env.JARVIS_TTS_KOKORO_ENABLED).toBe('true');
  });

  it('"voice status" returns status with active/inactive states', async () => {
    execMock = makeExecMock({ sttActive: 'active', cbActive: 'inactive', kokoroActive: 'inactive' });
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('voice status', ADMIN_ID);

    expect(reply).toMatch(/status/i);
    expect(reply).toMatch(/STT|whisper/i);
    expect(reply).toMatch(/Chatterbox/i);
    expect(reply).toMatch(/Kokoro/i);
    expect(reply).toMatch(/active/i);
    expect(reply).toMatch(/inactive/i);
  });

  it('"voice help" lists all commands', async () => {
    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('voice help', ADMIN_ID);

    expect(reply).toMatch(/voice on\/off/i);
    expect(reply).toMatch(/stt on\/off/i);
    expect(reply).toMatch(/tts on\/off/i);
    expect(reply).toMatch(/chatterbox/i);
    expect(reply).toMatch(/kokoro/i);
    expect(reply).toMatch(/voice status/i);
  });

  it('unknown command returns null (falls through to brain)', async () => {
    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('voice restart', ADMIN_ID);
    expect(reply).toBeNull();
  });

  it('handles sudo unavailable for STT start gracefully', async () => {
    execMock = makeExecMock({ sttActive: 'inactive', sudoOk: false });
    vi.doMock('child_process', () => ({ exec: execMock }));

    const { handleVoiceCommand } = await import('../discord-voice-commands.js');
    const reply = await handleVoiceCommand('stt on', ADMIN_ID);

    // Should still reply (warning or partial), not throw
    expect(reply).toBeDefined();
    expect(typeof reply).toBe('string');
  });
});

// ── persistEnvVars ────────────────────────────────────────────────────────────
describe('persistEnvVars', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.JARVIS_STT_ENABLED = process.env.JARVIS_STT_ENABLED;
    vi.resetModules();
    execMock = makeExecMock();
    vi.doMock('child_process', () => ({ exec: execMock }));
  });

  afterEach(() => {
    Object.assign(process.env, savedEnv);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('writes KEY=value to .env and updates process.env', async () => {
    const { writeFileSync } = await import('fs');
    const { persistEnvVars } = await import('../service-control.js');

    persistEnvVars({ JARVIS_STT_ENABLED: 'false' });

    expect(writeFileSync).toHaveBeenCalled();
    expect(process.env.JARVIS_STT_ENABLED).toBe('false');
  });

  it('updates existing key in .env content', async () => {
    const { readFileSync, existsSync, writeFileSync } = await import('fs');

    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue('JARVIS_STT_ENABLED=true\nOTHER_VAR=hello\n');
    writeFileSync.mockClear(); // clear previous calls so we only inspect this test's write

    const { persistEnvVars } = await import('../service-control.js');
    persistEnvVars({ JARVIS_STT_ENABLED: 'false' });

    // The written content should have the updated value, not the old one
    const writtenContent = writeFileSync.mock.calls
      .map(c => c[1])
      .find(c => typeof c === 'string' && c.includes('JARVIS_STT_ENABLED'));

    expect(writtenContent).toContain('JARVIS_STT_ENABLED=false');
    expect(writtenContent).toBeDefined();
    expect(writtenContent).not.toContain('JARVIS_STT_ENABLED=true');
    expect(writtenContent).toContain('OTHER_VAR=hello');
  });
});
