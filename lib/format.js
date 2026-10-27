// Offsets arrive as protobuf-style durations, for example "12.480s".
export function parseOffset(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  const match = String(value)
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)s?$/);
  return match ? Number.parseFloat(match[1]) : undefined;
}

export function formatTimestamp(seconds) {
  if (seconds === undefined || Number.isNaN(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Groups word-level annotations into lines. A new line starts when the
 * speaker changes, or every ~30 seconds for a single speaker, so the
 * transcript stays readable and every line carries a timestamp.
 */
export function formatWordTranscript(annotations, { maxLineSeconds = 30 } = {}) {
  const words = annotations.filter((a) => a?.type === 'word_info' && a.text);
  if (words.length === 0) return undefined;

  const lines = [];
  let current;
  for (const word of words) {
    const start = parseOffset(word.start_offset);
    const speaker = word.speaker;
    const startsNewLine =
      !current ||
      speaker !== current.speaker ||
      (start !== undefined && current.start !== undefined && start - current.start >= maxLineSeconds);
    if (startsNewLine) {
      current = { speaker, start, words: [] };
      lines.push(current);
    }
    current.words.push(word.text.trim());
  }

  return lines
    .map((line) => {
      const label = line.speaker ? ` ${line.speaker}:` : '';
      return `[${formatTimestamp(line.start)}]${label} ${line.words.join(' ').replace(/\s+([,.;:!?])/g, '$1')}`;
    })
    .join('\n');
}
