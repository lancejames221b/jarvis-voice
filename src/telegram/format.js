const TERSE_MAX = 120;
const TG_MAX = 4096;

export function terseStatus(fullText) {
  const text = String(fullText ?? '').trim();
  if (!text) return '(no output)';
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= TERSE_MAX) return firstLine;
  return firstLine.slice(0, TERSE_MAX - 1) + '…';
}

// Returns null when there is nothing beyond the terse line worth sending,
// otherwise an array of <=4096-char chunks for follow-up messages.
export function detailBody(fullText) {
  const text = String(fullText ?? '').trim();
  if (!text) return null;
  const isMultiline = text.includes('\n');
  if (!isMultiline && text.length <= TERSE_MAX) return null;
  const chunks = [];
  for (let i = 0; i < text.length; i += TG_MAX) {
    chunks.push(text.slice(i, i + TG_MAX));
  }
  return chunks;
}
