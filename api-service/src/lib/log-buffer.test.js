import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer } from './log-buffer.js';

describe('LogBuffer', () => {
  it('appends lines with monotonic sequence numbers', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    buf.append('first');
    buf.append('second');
    const { lines } = buf.since(0);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].seq, 1);
    assert.equal(lines[0].text, 'first');
    assert.equal(lines[1].seq, 2);
  });

  it('since cursor returns only newer lines', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    buf.append('a');
    buf.append('b');
    buf.append('c');
    const { lines, cursor } = buf.since(1);
    assert.deepEqual(lines.map(l => l.text), ['b', 'c']);
    assert.equal(cursor, 3);
  });

  it('evicts oldest when maxLines exceeded', () => {
    const buf = new LogBuffer({ maxLines: 3 });
    buf.append('1'); buf.append('2'); buf.append('3'); buf.append('4');
    const { lines } = buf.since(0);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].text, '2');
    assert.equal(lines[0].seq, 2);
  });

  it('since older than buffer returns all available with gap silent', () => {
    const buf = new LogBuffer({ maxLines: 3 });
    for (let i = 1; i <= 10; i++) buf.append(`line ${i}`);
    const { lines } = buf.since(0);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].text, 'line 8');
  });

  it('splits multi-line input into separate entries', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    buf.append('one\ntwo\nthree');
    const { lines } = buf.since(0);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map(l => l.text), ['one', 'two', 'three']);
  });

  it('returns empty when no new lines', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    buf.append('x');
    const { lines, cursor } = buf.since(1);
    assert.equal(lines.length, 0);
    assert.equal(cursor, 1);
  });

  it('cursor is current seq when nothing yet', () => {
    const buf = new LogBuffer({ maxLines: 100 });
    const { cursor } = buf.since(0);
    assert.equal(cursor, 0);
  });
});
