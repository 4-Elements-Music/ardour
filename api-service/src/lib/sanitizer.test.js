import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { luaString, resolveLibraryPath } from './sanitizer.js';

describe('luaString', () => {
  it('wraps a plain string in double quotes', () => {
    assert.equal(luaString('hello'), '"hello"');
  });

  it('escapes backslashes', () => {
    assert.equal(luaString('a\\b'), '"a\\\\b"');
  });

  it('escapes double quotes', () => {
    assert.equal(luaString('say "hi"'), '"say \\"hi\\""');
  });

  it('escapes newlines and carriage returns', () => {
    assert.equal(luaString('line1\nline2\rline3'), '"line1\\nline2\\rline3"');
  });

  it('escapes null bytes', () => {
    assert.equal(luaString('a\0b'), '"a\\0b"');
  });

  it('returns empty quotes for non-string input', () => {
    assert.equal(luaString(null), '""');
    assert.equal(luaString(undefined), '""');
    assert.equal(luaString(42), '""');
  });

  it('handles empty string', () => {
    assert.equal(luaString(''), '""');
  });

  it('handles combined escapes', () => {
    const result = luaString('path\\to\n"file"\0end');
    assert.equal(result, '"path\\\\to\\n\\"file\\"\\0end"');
  });
});

describe('resolveLibraryPath', () => {
  it('resolves a simple relative path', () => {
    const result = resolveLibraryPath('stems/kick.wav', '/data/library');
    assert.equal(result, '/data/library/stems/kick.wav');
  });

  it('throws on parent directory traversal', () => {
    assert.throws(
      () => resolveLibraryPath('../etc/passwd', '/data/library'),
      /Path traversal/
    );
  });

  it('throws on double-dot in the middle', () => {
    assert.throws(
      () => resolveLibraryPath('stems/../../etc/passwd', '/data/library'),
      /Path traversal/
    );
  });

  it('allows nested subdirectories', () => {
    const result = resolveLibraryPath('drums/acoustic/kick.wav', '/data/library');
    assert.equal(result, '/data/library/drums/acoustic/kick.wav');
  });
});
