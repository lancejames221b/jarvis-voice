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
    // ffmpeg invoked with the OGG input and a 16k mono wav output
    const cmd = exec.mock.calls[0][0];
    expect(cmd).toMatch(/ffmpeg .*\/tmp\/v\.oga.* -ar 16000 -ac 1 .*\/tmp\/v\.oga\.wav/);
    expect(transcribe).toHaveBeenCalledWith('/tmp/v.oga.wav');
  });

  it('returns empty string and cleans up when ffmpeg fails', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('ffmpeg boom'));
    const transcribe = vi.fn();
    const out = await transcribeVoiceNote('/tmp/v.oga', { exec, transcribe });
    expect(out).toBe('');
    expect(transcribe).not.toHaveBeenCalled();
    // both temp files attempted for cleanup
    expect(unlink).toHaveBeenCalledWith('/tmp/v.oga.wav');
    expect(unlink).toHaveBeenCalledWith('/tmp/v.oga');
  });

  it('always cleans up temp files on the success path too', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const transcribe = vi.fn().mockResolvedValue('ok');
    await transcribeVoiceNote('/tmp/v.oga', { exec, transcribe });
    expect(unlink).toHaveBeenCalledWith('/tmp/v.oga.wav');
    expect(unlink).toHaveBeenCalledWith('/tmp/v.oga');
  });
});
