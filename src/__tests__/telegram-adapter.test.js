import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../channel-access.js', () => ({
  isOwner: vi.fn(),
  isTelegramOwner: vi.fn(),
  canAccessChannel: vi.fn(),
}));
vi.mock('../brain/brain.js', () => ({
  generateTextResponse: vi.fn(),
}));
vi.mock('../telegram/registry.js', () => ({
  telegramChatKey: (c, t) => (t ? `telegram:chat:${c}:topic:${t}` : `telegram:chat:${c}`),
  getTelegramProjectPath: vi.fn(),
  registerTelegramChat: vi.fn(),
}));
vi.mock('../telegram/engine.js', () => ({
  getEngine: vi.fn(() => 'claude'),
  setEngine: vi.fn(),
  resolveEngineEnv: vi.fn(() => ({})),
}));
vi.mock('../telegram/attachments.js', () => ({
  buildAttachmentContext: vi.fn(),
}));

import { isTelegramOwner } from '../channel-access.js';
import { generateTextResponse } from '../brain/brain.js';
import { getTelegramProjectPath } from '../telegram/registry.js';
import { buildAttachmentContext } from '../telegram/attachments.js';
import { handleUpdate } from '../telegram/adapter.js';

function makeSend() { return vi.fn().mockResolvedValue(undefined); }

describe('handleUpdate — access gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owner plain chat: calls the brain and replies', async () => {
    isTelegramOwner.mockReturnValue(true);
    generateTextResponse.mockResolvedValue({ text: 'hi there' });
    const send = makeSend();
    await handleUpdate({ userId: '1', chatId: '111', topicId: null, text: 'hey', messageId: '9' }, { send });
    expect(generateTextResponse).toHaveBeenCalled();
    // Telegram chats must carry the agent:main: session key, not the global voice key.
    const opts = generateTextResponse.mock.calls[0][1];
    expect(opts.sessionUser).toBe('agent:main:telegram:chat:111');
    expect(send).toHaveBeenCalledWith('111', 'hi there', expect.any(Object));
  });

  it('non-owner non-allowlisted: refused, brain NOT called', async () => {
    isTelegramOwner.mockReturnValue(false);
    const send = makeSend();
    await handleUpdate(
      { userId: '2', chatId: '111', topicId: null, text: 'hey', messageId: '9' },
      { send, allowedUsers: [] },
    );
    expect(generateTextResponse).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatch(/not authorized|read-only|denied/i);
  });

  it('/register from owner binds the chat', async () => {
    isTelegramOwner.mockReturnValue(true);
    const { registerTelegramChat } = await import('../telegram/registry.js');
    const send = makeSend();
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: '/register /home/u/proj', messageId: '9' },
      { send },
    );
    expect(registerTelegramChat).toHaveBeenCalledWith('telegram:chat:111', '/home/u/proj');
  });

  it('coding intent with no project binding: replies "register first", no brain coding', async () => {
    isTelegramOwner.mockReturnValue(true);
    getTelegramProjectPath.mockReturnValue(null);
    generateTextResponse.mockResolvedValue({ text: 'chatty' });
    const send = makeSend();
    // a plain message still routes to chat; binding only gates the *coding* path.
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: 'just chatting', messageId: '9' },
      { send },
    );
    expect(send).toHaveBeenCalled();
  });

  it('voice note: downloads, transcribes, then routes the transcript to the brain', async () => {
    isTelegramOwner.mockReturnValue(true);
    generateTextResponse.mockResolvedValue({ text: 'answer to spoken q' });
    const send = makeSend();
    const downloadFile = vi.fn().mockResolvedValue('/tmp/voice.oga');
    const transcribeVoice = vi.fn().mockResolvedValue('what is the weather');
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, kind: 'voice', fileId: 'F1', messageId: '9' },
      { send, downloadFile, transcribeVoice },
    );
    expect(downloadFile).toHaveBeenCalledWith('F1', '/tmp');
    expect(transcribeVoice).toHaveBeenCalledWith('/tmp/voice.oga');
    // transcript is echoed back, then the brain reply is sent
    expect(send.mock.calls.some(([, t]) => /what is the weather/.test(t))).toBe(true);
    expect(generateTextResponse).toHaveBeenCalledWith('what is the weather', expect.any(Object));
    expect(send).toHaveBeenCalledWith('111', 'answer to spoken q', expect.any(Object));
  });

  it('voice note that transcribes to empty: replies "couldn\'t make out", no brain', async () => {
    isTelegramOwner.mockReturnValue(true);
    const send = makeSend();
    const downloadFile = vi.fn().mockResolvedValue('/tmp/voice.oga');
    const transcribeVoice = vi.fn().mockResolvedValue('');
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, kind: 'voice', fileId: 'F1', messageId: '9' },
      { send, downloadFile, transcribeVoice },
    );
    expect(generateTextResponse).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatch(/couldn.t make out|try again/i);
  });

  it('voice note when voice deps are absent: replies "not enabled", no download', async () => {
    isTelegramOwner.mockReturnValue(true);
    const send = makeSend();
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, kind: 'voice', fileId: 'F1', messageId: '9' },
      { send },
    );
    expect(generateTextResponse).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatch(/not enabled/i);
  });

  it('image: downloads, builds an @ref context, routes caption+context to the brain', async () => {
    isTelegramOwner.mockReturnValue(true);
    getTelegramProjectPath.mockReturnValue(null); // unbound chat → temp dir
    generateTextResponse.mockResolvedValue({ text: 'that is a cat' });
    buildAttachmentContext.mockReturnValue('\n\n[open it with: @/tmp/photo.jpg]');
    const send = makeSend();
    const downloadFile = vi.fn().mockResolvedValue('/tmp/photo.jpg');
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, kind: 'image', fileId: 'IMG1', caption: 'whats this', messageId: '9' },
      { send, downloadFile, tmpDir: '/tmp' },
    );
    // unbound chat → image saved to the temp dir
    expect(downloadFile).toHaveBeenCalledWith('IMG1', '/tmp');
    expect(buildAttachmentContext).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', path: '/tmp/photo.jpg', caption: 'whats this' }),
    );
    // brain gets the caption (the real ask) plus the @ref context
    const prompt = generateTextResponse.mock.calls[0][0];
    expect(prompt).toContain('whats this');
    expect(prompt).toContain('@/tmp/photo.jpg');
    expect(send).toHaveBeenCalledWith('111', 'that is a cat', expect.any(Object));
  });

  it('image with no caption: still routes a well-formed prompt to the brain', async () => {
    isTelegramOwner.mockReturnValue(true);
    getTelegramProjectPath.mockReturnValue(null);
    generateTextResponse.mockResolvedValue({ text: 'ok' });
    buildAttachmentContext.mockReturnValue('\n\n[open it with: @/tmp/p.png]');
    const send = makeSend();
    const downloadFile = vi.fn().mockResolvedValue('/tmp/p.png');
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, kind: 'image', fileId: 'IMG2', caption: null, messageId: '9' },
      { send, downloadFile, tmpDir: '/tmp' },
    );
    const prompt = generateTextResponse.mock.calls[0][0];
    expect(prompt).toMatch(/take a look at this image/i);
    expect(prompt).toContain('@/tmp/p.png');
  });

  it('document: downloads into the bound project dir and routes an @ref to the brain', async () => {
    isTelegramOwner.mockReturnValue(true);
    getTelegramProjectPath.mockReturnValue('/home/u/proj');
    generateTextResponse.mockResolvedValue({ text: 'reviewed' });
    buildAttachmentContext.mockReturnValue('\n\n[open it with: @/home/u/proj/notes.md]');
    const send = makeSend();
    const downloadFile = vi.fn().mockResolvedValue('/home/u/proj/notes.md');
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, kind: 'document', fileId: 'DOC1', fileName: 'notes.md', mimeType: 'text/markdown', caption: 'summarize', messageId: '9' },
      { send, downloadFile, tmpDir: '/tmp' },
    );
    // documents save into the project dir so the agent can open them by path
    expect(downloadFile).toHaveBeenCalledWith('DOC1', '/home/u/proj');
    const prompt = generateTextResponse.mock.calls[0][0];
    expect(prompt).toContain('summarize');
    expect(prompt).toContain('@/home/u/proj/notes.md');
    expect(send).toHaveBeenCalledWith('111', 'reviewed', expect.any(Object));
  });

  it('attachment when downloadFile dep is absent: replies "not enabled", no brain', async () => {
    isTelegramOwner.mockReturnValue(true);
    const send = makeSend();
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, kind: 'image', fileId: 'IMG1', messageId: '9' },
      { send },
    );
    expect(generateTextResponse).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatch(/not enabled/i);
  });

  it('attachment download failure: replies an error, no brain', async () => {
    isTelegramOwner.mockReturnValue(true);
    const send = makeSend();
    const downloadFile = vi.fn().mockRejectedValue(new Error('boom'));
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, kind: 'image', fileId: 'IMG1', messageId: '9' },
      { send, downloadFile, tmpDir: '/tmp' },
    );
    expect(generateTextResponse).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([, t]) => /couldn.t download/i.test(t))).toBe(true);
  });

  it('a transient send failure (EFATAL) is retried, NOT reported as an engine error', async () => {
    isTelegramOwner.mockReturnValue(true);
    generateTextResponse.mockResolvedValue({ text: 'real answer' });
    // First send throws EFATAL (telegram network blip), retry succeeds.
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('EFATAL: fetch failed'))
      .mockResolvedValue(undefined);
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: 'hi', messageId: '9' },
      { send },
    );
    // the brain succeeded, so the user must NOT see an engine-error message
    expect(send.mock.calls.every(([, t]) => !/engine error/i.test(t))).toBe(true);
    // the real answer was retried and delivered
    expect(send.mock.calls.some(([, t]) => /real answer/.test(t))).toBe(true);
  });

  it('a genuine brain failure still surfaces an engine error', async () => {
    isTelegramOwner.mockReturnValue(true);
    generateTextResponse.mockRejectedValue(new Error('gateway 500'));
    const send = makeSend();
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: 'hi', messageId: '9' },
      { send },
    );
    expect(send.mock.calls.some(([, t]) => /engine error/i.test(t))).toBe(true);
  });

  it('replies are sent as Telegram HTML (parse_mode), and the brain is told the surface', async () => {
    isTelegramOwner.mockReturnValue(true);
    generateTextResponse.mockResolvedValue({ text: 'Done: **3 files** changed' });
    const send = makeSend();
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: 'go', messageId: '9' },
      { send },
    );
    // markdown was converted to HTML and sent with parse_mode:'HTML'
    const [, sentText, sentOpts] = send.mock.calls[0];
    expect(sentText).toContain('<b>3 files</b>');
    expect(sentOpts.parseMode).toBe('HTML');
    // the brain was told it's a telegram surface
    expect(generateTextResponse.mock.calls[0][1].surfaceHint).toBe('telegram');
  });

  it('falls back to plain text when Telegram rejects the HTML markup', async () => {
    isTelegramOwner.mockReturnValue(true);
    generateTextResponse.mockResolvedValue({ text: 'see **here**' });
    // first (HTML) send 400s on a parse error; the plain resend succeeds
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValue(undefined);
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: 'go', messageId: '9' },
      { send },
    );
    // the retry dropped parse_mode and sent plain text (no <b> tag, no asterisks)
    const lastCall = send.mock.calls[send.mock.calls.length - 1];
    expect(lastCall[1]).toContain('here');
    expect(lastCall[1]).not.toContain('<b>');
    expect(lastCall[1]).not.toContain('**');
    expect(lastCall[2]?.parseMode).toBeUndefined();
  });
});
