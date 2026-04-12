/**
 * Bounded ring buffer for per-session log capture.
 * Each appended line gets a monotonically-increasing sequence number.
 * When maxLines is exceeded, oldest lines are evicted.
 */
export class LogBuffer {
  constructor({ maxLines = 10000 } = {}) {
    this._maxLines = maxLines;
    this._lines = []; // [{ seq, text }]
    this._nextSeq = 1;
  }

  /**
   * Append text (may contain newlines — split into separate entries).
   */
  append(text) {
    if (text == null || text === '') return;
    const parts = String(text).split('\n');
    for (const p of parts) {
      if (p === '' && parts.length > 1 && p === parts[parts.length - 1]) continue; // trailing newline
      this._lines.push({ seq: this._nextSeq++, text: p });
    }
    while (this._lines.length > this._maxLines) {
      this._lines.shift();
    }
  }

  /**
   * Return lines with seq > cursor, plus the new cursor value.
   */
  since(cursor) {
    const c = parseInt(cursor, 10) || 0;
    const lines = this._lines.filter(l => l.seq > c);
    const newCursor = this._lines.length > 0 ? this._lines[this._lines.length - 1].seq : c;
    return { lines, cursor: newCursor };
  }
}
