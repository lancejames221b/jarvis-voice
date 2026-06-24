import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks must be declared before imports ────────────────────────────
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// discord.js AttachmentBuilder — capture name + payload, no real Discord.
vi.mock('discord.js', () => ({
  AttachmentBuilder: class {
    constructor(data, opts) {
      this.attachment = data;
      this.name = opts?.name;
    }
  },
}));

// child_process.execFile -> drive cgg/mmdc outcomes per test.
const execFileImpl = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args) => execFileImpl(...args),
}));

// fs/promises — control file existence + .mmd contents without touching disk.
const fsState = { access: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), unlink: vi.fn() };
vi.mock('fs/promises', () => ({
  default: {
    access: (...a) => fsState.access(...a),
    readFile: (...a) => fsState.readFile(...a),
    writeFile: (...a) => fsState.writeFile(...a),
    unlink: (...a) => fsState.unlink(...a),
  },
  access: (...a) => fsState.access(...a),
  readFile: (...a) => fsState.readFile(...a),
  writeFile: (...a) => fsState.writeFile(...a),
  unlink: (...a) => fsState.unlink(...a),
}));

import { parseCggIntent, tryCggDispatch } from '../cgg-dispatch.js';

const BASE = '/home/user/Dev/proj';

function makeMessage() {
  const replies = [];
  return {
    replies,
    author: { tag: 'tester#0001' },
    channelId: 'chan',
    channel: { sendTyping: vi.fn(async () => {}), send: vi.fn(async () => {}) },
    reply: vi.fn(async (payload) => {
      replies.push(payload);
    }),
  };
}

// execFile(file, args, opts, cb) — node calls the callback. Our promisified
// wrapper expects (err, { stdout, stderr }). Route by binary name.
function wireExec({ cggStderr = 'cgg: ok', cggErr = null, mmdcErr = null } = {}) {
  execFileImpl.mockImplementation((file, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (String(file).includes('cgg')) {
      if (cggErr) return done(Object.assign(new Error('cgg fail'), { stderr: cggErr }));
      return done(null, { stdout: '', stderr: cggStderr });
    }
    // mmdc
    if (mmdcErr) return done(Object.assign(new Error('mmdc fail'), { stderr: mmdcErr }));
    return done(null, { stdout: '', stderr: '' });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fsState.access.mockResolvedValue(undefined); // path exists by default
  fsState.writeFile.mockResolvedValue(undefined);
  fsState.unlink.mockResolvedValue(undefined);
});

describe('parseCggIntent', () => {
  it('parses explicit !cgg with positional filter + bare-int hops', () => {
    expect(parseCggIntent('!cgg src/a.js foo 1')).toEqual({
      path: 'src/a.js', filters: ['foo'], hops: 1,
    });
  });

  it('parses --filter and -n flags', () => {
    expect(parseCggIntent('!cgg src/a.js --filter bar -n 0')).toEqual({
      path: 'src/a.js', filters: ['bar'], hops: 0,
    });
  });

  it('parses NL "call graph of X"', () => {
    expect(parseCggIntent('call graph of src/voice')).toEqual({
      path: 'src/voice', filters: [], hops: null,
    });
  });

  it('parses "callgraph" and "cgg" NL prefixes', () => {
    expect(parseCggIntent('callgraph src/x')?.path).toBe('src/x');
    expect(parseCggIntent('cgg src/y')?.path).toBe('src/y');
  });

  it('tolerates a leading wake-word', () => {
    expect(parseCggIntent('jarvis, call graph of src/z')?.path).toBe('src/z');
  });

  it('returns null for non-cgg messages', () => {
    expect(parseCggIntent('what time is it')).toBeNull();
    expect(parseCggIntent('!help')).toBeNull();
    expect(parseCggIntent('')).toBeNull();
  });
});

describe('tryCggDispatch', () => {
  it('falls through (handled=false) when no cgg intent', async () => {
    const m = makeMessage();
    const res = await tryCggDispatch(m, 'hello jarvis', { base: BASE });
    expect(res.handled).toBe(false);
    expect(m.reply).not.toHaveBeenCalled();
  });

  it('refuses a path that escapes the base', async () => {
    const m = makeMessage();
    const res = await tryCggDispatch(m, '!cgg ../../../etc/passwd', { base: BASE });
    expect(res.handled).toBe(true);
    expect(m.reply.mock.calls[0][0]).toMatch(/refusing path/i);
  });

  it('reports a not-found path', async () => {
    fsState.access.mockRejectedValueOnce(new Error('ENOENT'));
    const m = makeMessage();
    const res = await tryCggDispatch(m, '!cgg src/missing.js', { base: BASE });
    expect(res.handled).toBe(true);
    expect(m.reply.mock.calls[0][0]).toMatch(/not found/i);
  });

  it('renders PNG + attaches .mmd on success', async () => {
    wireExec({ cggStderr: 'cgg: 1 files, 44 callables' });
    // first readFile = .mmd text (non-empty), second = png buffer
    fsState.readFile
      .mockResolvedValueOnce('flowchart LR\n  A --> B')
      .mockResolvedValueOnce(Buffer.from('PNGDATA'));
    const m = makeMessage();
    const res = await tryCggDispatch(m, '!cgg src/a.js foo 1', { base: BASE });
    expect(res.handled).toBe(true);
    const payload = m.reply.mock.calls[0][0];
    expect(payload.content).toMatch(/\*\*cgg\*\*/);
    const names = payload.files.map((f) => f.name).sort();
    expect(names).toEqual(['callgraph.mmd', 'callgraph.png']);
  });

  it('attaches only .mmd when mmdc render fails', async () => {
    wireExec({ mmdcErr: 'chromium boom' });
    fsState.readFile.mockResolvedValueOnce('flowchart LR\n  A --> B'); // .mmd only; png read never reached
    const m = makeMessage();
    const res = await tryCggDispatch(m, '!cgg src/a.js', { base: BASE });
    expect(res.handled).toBe(true);
    const payload = m.reply.mock.calls[0][0];
    const names = payload.files.map((f) => f.name);
    expect(names).toEqual(['callgraph.mmd']);
    expect(payload.content).toMatch(/PNG render unavailable/i);
  });

  it('reports cgg failure to the channel', async () => {
    wireExec({ cggErr: 'no such filter' });
    const m = makeMessage();
    const res = await tryCggDispatch(m, '!cgg src/a.js', { base: BASE });
    expect(res.handled).toBe(true);
    expect(m.reply.mock.calls[0][0]).toMatch(/cgg:.*no such filter/i);
  });

  it('reports no-match when the mermaid is empty', async () => {
    wireExec({ cggStderr: 'cgg: 0 callables' });
    fsState.readFile.mockResolvedValueOnce('   '); // empty/whitespace .mmd
    const m = makeMessage();
    const res = await tryCggDispatch(m, '!cgg src/a.js nomatch', { base: BASE });
    expect(res.handled).toBe(true);
    expect(m.reply.mock.calls[0][0]).toMatch(/no callables matched/i);
  });
});
