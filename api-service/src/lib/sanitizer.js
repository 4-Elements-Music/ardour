import { resolve, relative } from 'path';

/**
 * Escape a string for safe inclusion in a Lua string literal.
 * Prevents Lua injection via track names, file paths, etc.
 */
export function luaString(str) {
  if (typeof str !== 'string') return '""';
  return '"' + str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
    + '"';
}

/**
 * Validate that a file path is within the allowed library base directory.
 * Returns the resolved absolute path or throws on path traversal.
 */
export function resolveLibraryPath(relativePath, baseDir) {
  const resolved = resolve(baseDir, relativePath);
  const rel = relative(baseDir, resolved);
  if (rel.startsWith('..') || resolve(baseDir, rel) !== resolved) {
    throw new Error('Path traversal detected: ' + relativePath);
  }
  return resolved;
}
