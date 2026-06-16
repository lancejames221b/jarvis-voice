/**
 * vision.js — describe a Telegram image so the text-only brain can comprehend it.
 *
 * The gateway flattens every prompt to plain text before handing it to
 * `claude -p` (collapseMessages/contentToText drop non-text content blocks),
 * and headless `claude -p` cannot reliably "see" an image by file path. So the
 * only way to let the agent reason over a picture is to turn the pixels into
 * words HERE, then inject that description into the prompt.
 *
 * We do that with the local LM Studio vision model (qwen3.6-35b-a3b, confirmed
 * multimodal) via its OpenAI-compatible /v1/chat/completions endpoint — free,
 * local, no API key. The description is deliberately faithful and literal
 * (transcribe text, name objects, read charts) so the agent can act on it as if
 * it had seen the image itself.
 */
import { readFile } from 'fs/promises';
import logger from '../logger.js';

// Reachable LM Studio host. JARVIS_LMS_BASE_URL's default (lmstudio.local) does
// not resolve from the live host, so vision gets its own override that points at
// the box actually serving the model.
function visionBaseUrl() {
  return (process.env.JARVIS_VISION_BASE_URL
    || process.env.JARVIS_LMS_BASE_URL
    || 'http://127.0.0.1:1234').replace(/\/+$/, '');
}

function visionModel() {
  return process.env.JARVIS_VISION_MODEL
    || process.env.JARVIS_LMS_MODEL
    || 'qwen/qwen3.6-35b-a3b';
}

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
};

function mimeForPath(p, fallback = 'image/jpeg') {
  const ext = p.split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXT[ext] || fallback;
}

const PROMPT =
  'Describe this image in faithful, literal detail so someone who cannot see it '
  + 'could act on it. Transcribe any visible text verbatim, name the objects, '
  + 'people, UI elements, charts, or code, and note colors and layout where they '
  + 'matter. Do not speculate beyond what is shown. Be thorough but concise.';

/**
 * Produce a literal description of an image file using the local vision model.
 *
 * @param {string} imagePath   path to the downloaded image on disk
 * @param {string} [caption]   the user's caption, given to the model as intent
 * @param {object} [deps]      injectable for tests: { fetch, read, baseUrl, model, mime }
 * @returns {Promise<string>}  description text, or '' on any failure
 */
export async function describeImage(imagePath, caption = '', deps = {}) {
  const doFetch = deps.fetch || fetch;
  const read = deps.read || readFile;
  const baseUrl = deps.baseUrl || visionBaseUrl();
  const model = deps.model || visionModel();
  const mime = deps.mime || mimeForPath(imagePath);

  let dataUrl;
  try {
    const buf = await read(imagePath);
    dataUrl = `data:${mime};base64,${Buffer.from(buf).toString('base64')}`;
  } catch (err) {
    logger.warn({ err: err.message, imagePath }, '[telegram-vision] read failed');
    return '';
  }

  const userText = caption
    ? `${PROMPT}\n\nThe sender added this caption: "${caption}"`
    : PROMPT;

  const body = {
    model,
    max_tokens: 700,
    // qwen a3b is a thinking model; left on, it can burn the whole budget on
    // reasoning and return empty content. Disable thinking for a direct answer.
    chat_template_kwargs: { enable_thinking: false },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  };

  try {
    const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, imagePath }, '[telegram-vision] model HTTP error');
      return '';
    }
    const json = await res.json();
    const msg = json?.choices?.[0]?.message;
    // Prefer real content; fall back to reasoning_content if the model still
    // routed its answer there despite enable_thinking:false.
    const text = (msg?.content || msg?.reasoning_content || '').trim();
    return text;
  } catch (err) {
    logger.warn({ err: err.message, imagePath }, '[telegram-vision] describe failed');
    return '';
  }
}
