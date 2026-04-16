// Thin wrapper around the preset index SQLite DB for use in MCP handlers.
// Opens lazily on first use; safe for the single-process Fastify app.

import { openDb, searchPresets, recordCapture, getCaptureByUri, DEFAULT_DB_PATH } from '../indexer/db.js';
import { loadKnownFuids } from '../indexer/nksf-to-vstpreset.js';

export class PresetStore {
  constructor({ dbPath = DEFAULT_DB_PATH } = {}) {
    this.dbPath = dbPath;
    this._db = null;
  }
  db() {
    if (!this._db) this._db = openDb(this.dbPath);
    return this._db;
  }
  search(opts) {
    return searchPresets(this.db(), opts || {});
  }
  recordCapture(entry) {
    return recordCapture(this.db(), entry);
  }
  captureByUri(uri) {
    return getCaptureByUri(this.db(), uri);
  }
  knownFuids() {
    return loadKnownFuids();
  }
  close() {
    if (this._db) { this._db.close(); this._db = null; }
  }
}
