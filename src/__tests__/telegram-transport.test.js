import { describe, it, expect, vi } from 'vitest';
import { normalizeUpdate, splitSend } from '../telegram/transport.js';

describe('normalizeUpdate', () => {
  it('extracts a neutral shape from a basic message', () => {
    const msg = {
      message_id: 9,
      from: { id: 555 },
      chat: { id: 111 },
      text: 'hello',
    };
    expect(normalizeUpdate(msg)).toEqual({
      userId: '555', chatId: '111', topicId: null, kind: 'text', text: 'hello', messageId: '9',
    });
  });
  it('captures a forum topic id when present', () => {
    const msg = {
      message_id: 9, from: { id: 555 }, chat: { id: 111 },
      message_thread_id: 222, text: 'hi',
    };
    expect(normalizeUpdate(msg).topicId).toBe('222');
  });
  it('normalizes a voice note to a kind:voice update with the file id', () => {
    const msg = {
      message_id: 9, from: { id: 555 }, chat: { id: 111 },
      voice: { file_id: 'AAA-file', duration: 3 },
    };
    expect(normalizeUpdate(msg)).toEqual({
      userId: '555', chatId: '111', topicId: null, messageId: '9',
      kind: 'voice', fileId: 'AAA-file', duration: 3, caption: null,
    });
  });
  it('normalizes a photo to a kind:image update using the largest size variant', () => {
    const msg = {
      message_id: 9, from: { id: 555 }, chat: { id: 111 },
      photo: [
        { file_id: 'small', width: 90 },
        { file_id: 'large', width: 1280 },
      ],
      caption: 'look',
    };
    expect(normalizeUpdate(msg)).toEqual({
      userId: '555', chatId: '111', topicId: null, messageId: '9',
      kind: 'image', fileId: 'large', caption: 'look',
    });
  });
  it('normalizes a document to a kind:document update with name + mime', () => {
    const msg = {
      message_id: 9, from: { id: 555 }, chat: { id: 111 },
      document: { file_id: 'DOC1', file_name: 'report.pdf', mime_type: 'application/pdf' },
      caption: 'read this',
    };
    expect(normalizeUpdate(msg)).toEqual({
      userId: '555', chatId: '111', topicId: null, messageId: '9',
      kind: 'document', fileId: 'DOC1', fileName: 'report.pdf',
      mimeType: 'application/pdf', caption: 'read this',
    });
  });
  it('routes a document with an image/* mime to the image path', () => {
    const msg = {
      message_id: 9, from: { id: 555 }, chat: { id: 111 },
      document: { file_id: 'IMGDOC', file_name: 'shot.png', mime_type: 'image/png' },
    };
    const out = normalizeUpdate(msg);
    expect(out.kind).toBe('image');
    expect(out.fileId).toBe('IMGDOC');
    expect(out.mimeType).toBe('image/png');
  });
  it('returns null for an unhandled message type (e.g. a sticker)', () => {
    expect(normalizeUpdate({ message_id: 9, from: { id: 5 }, chat: { id: 1 } })).toBeNull();
  });
});

describe('splitSend', () => {
  it('calls the sender once for a short message', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    await splitSend(sender, '111', 'short', { topicId: null });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith('111', 'short', {});
  });
  it('passes message_thread_id through when a topic is set', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    await splitSend(sender, '111', 'x', { topicId: '222' });
    expect(sender).toHaveBeenCalledWith('111', 'x', { message_thread_id: '222' });
  });
});
