/**
 * voice-in.js — Telegram voice-note transcription.
 *
 * Telegram delivers voice notes as OGG/Opus. The STT pipeline
 * (transcribeWhisperOnly) wants a 16 kHz mono WAV. This module bridges the two:
 * transcode the OGG to WAV with ffmpeg, run Whisper-only STT (no speaker gate —
 * a Telegram sender won't match the local voiceprint), return the text, and
 * always clean up the temp WAV.
 *
 * Download of the OGG itself is the transport's job (bot.downloadFile); this
 * module starts from a local OGG path so it stays pure and unit-testable with
 * an injected exec/transcribe.
 */
import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import { transcribeWhisperOnly } from '../voice/stt.js';
import logger from '../logger.js';

const execAsync = promisify(_exec);

/**
 * Transcribe a downloaded Telegram voice note (OGG/Opus) to text.
 *
 * @param {string} oggPath - path to the downloaded .oga/.ogg file
 * @param {object} [deps] - injectable for tests: { exec, transcribe }
 * @returns {Promise<string>} transcript ('' on empty/failed transcription)
 */
export async function transcribeVoiceNote(oggPath, deps = {}) {
  const exec = deps.exec || execAsync;
  const transcribe = deps.transcribe || transcribeWhisperOnly;
  // Unique WAV path per invocation. downloadFile names the OGG deterministically
  // from Telegram's file_path, so two overlapping handlers for the SAME voice
  // note would otherwise transcode to the same wav and double-delete it mid-read.
  const uniq = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const wavPath = `${oggPath}.${uniq}.wav`;

  try {
    // OGG/Opus -> 16 kHz mono PCM WAV (Whisper's expected input).
    // killSignal SIGKILL so a hung ffmpeg dies immediately on timeout rather
    // than flushing a partial wav after the finally-block unlink.
    await exec(
      `ffmpeg -y -i "${oggPath}" -ar 16000 -ac 1 -acodec pcm_s16le "${wavPath}"`,
      { timeout: 60_000, killSignal: 'SIGKILL' },
    );
    const text = (await transcribe(wavPath)) || '';
    return text.trim();
  } catch (err) {
    logger.warn({ err: err.message, oggPath }, '[telegram-voice] transcription failed');
    return '';
  } finally {
    // Best-effort cleanup of both temp files; never throws.
    await unlink(wavPath).catch(() => {});
    await unlink(oggPath).catch(() => {});
  }
}
