import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../voice/stt.js', () => ({ transcribeWhisperOnly: vi.fn() }));
// fs/promises.unlink is called for cleanup — stub it so tests don't touch disk.
vi.mock('fs/promises', () => ({ unlink: vi.fn().mockResolvedValue(undefined) }));

import { unlink } from 'fs/promises';
import { transcribeVoiceNote } from '../telegram/voice-in.js';

describe('transcribeVoiceNote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('transcodes the OGG then returns the trimmed transcript', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const transcribe = vi.fn().mockResolvedValue('  hello there  ');
    const out = await transcribeVoiceNote('/tmp/v.oga', { exec, transcribe });
    expect(out).toBe('hello there');
    // ffmpeg invoked with the OGG input and a 16k mono wav output. The wav path
    // carries a unique per-invocation suffix to avoid concurrent collisions.
    const cmd = exec.mock.calls[0][0];
    expect(cmd).toMatch(/ffmpeg .*\/tmp\/v\.oga.* -ar 16000 -ac 1 .*\/tmp\/v\.oga\..*\.wav/);
    // whatever unique wav path ffmpeg wrote is exactly what we transcribe + clean up
    const wavArg = cmd.match(/"(\/tmp\/v\.oga\.[^"]+\.wav)"/)[1];
    expect(transcribe).toHaveBeenCalledWith(wavArg);
  });

  it('returns empty string and cleans up when ffmpeg fails', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('ffmpeg boom'));
    const transcribe = vi.fn();
    const out = await transcribeVoiceNote('/tmp/v.oga', { exec, transcribe });
    expect(out).toBe('');
    expect(transcribe).not.toHaveBeenCalled();
    // both temp files attempted for cleanup (wav carries a unique suffix)
    const unlinked = unlink.mock.calls.map((c) => c[0]);
    expect(unlinked).toContain('/tmp/v.oga');
    expect(unlinked.some((p) => /^\/tmp\/v\.oga\..*\.wav$/.test(p))).toBe(true);
  });

  it('always cleans up temp files on the success path too', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const transcribe = vi.fn().mockResolvedValue('ok');
    await transcribeVoiceNote('/tmp/v.oga', { exec, transcribe });
    const unlinked = unlink.mock.calls.map((c) => c[0]);
    expect(unlinked).toContain('/tmp/v.oga');
    expect(unlinked.some((p) => /^\/tmp\/v\.oga\..*\.wav$/.test(p))).toBe(true);
  });
});
