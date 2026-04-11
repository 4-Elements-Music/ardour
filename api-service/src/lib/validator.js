import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(__dirname, '../schemas/job-spec.json'), 'utf-8')
);

const ajv = new Ajv({ allErrors: true });
const validateSchema = ajv.compile(schema);

/**
 * Validate a job spec against the JSON schema and apply size limit checks
 * that go beyond what the schema can express.
 *
 * @param {object} spec - The parsed job spec
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateJobSpec(spec) {
  const errors = [];

  if (!validateSchema(spec)) {
    for (const err of validateSchema.errors) {
      const path = err.instancePath || '/';
      errors.push(`${path}: ${err.message}`);
    }
    return { valid: false, errors };
  }

  // Size limits from config
  if (spec.tracks.length > config.maxTracks) {
    errors.push(`Too many tracks: ${spec.tracks.length} (max ${config.maxTracks})`);
  }

  for (const track of spec.tracks) {
    if ((track.regions || []).length > config.maxRegionsPerTrack) {
      errors.push(`Track "${track.name}": too many regions (max ${config.maxRegionsPerTrack})`);
    }
    if ((track.plugins || []).length > config.maxPluginsPerTrack) {
      errors.push(`Track "${track.name}": too many plugins (max ${config.maxPluginsPerTrack})`);
    }
    if (track.type === 'audio' && track.instrument) {
      errors.push(`Track "${track.name}": audio tracks cannot have an instrument`);
    }
  }

  // Tempo array must start at bar 1
  if (spec.session.tempo[0].bar !== 1) {
    errors.push('First tempo entry must be at bar 1');
  }

  // Time signature array must start at bar 1
  if (spec.session.time_signature[0].bar !== 1) {
    errors.push('First time_signature entry must be at bar 1');
  }

  // Render range must be within session duration
  if (spec.session.render_range) {
    if (spec.session.render_range.end_bar > spec.session.duration_bars) {
      errors.push('render_range.end_bar exceeds session duration_bars');
    }
    if (spec.session.render_range.start_bar >= spec.session.render_range.end_bar) {
      errors.push('render_range.start_bar must be less than end_bar');
    }
  }

  // Plugin automation must reference valid indices
  for (const track of spec.tracks) {
    for (const auto of (track.automation || [])) {
      if (auto.target === 'plugin') {
        if (auto.plugin_index === undefined) {
          errors.push(`Track "${track.name}": plugin automation requires plugin_index`);
        }
        if (auto.param_index === undefined) {
          errors.push(`Track "${track.name}": plugin automation requires param_index`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
