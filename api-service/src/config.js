import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARDOUR_ROOT = resolve(__dirname, '../../');

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  arluaBin: resolve(ARDOUR_ROOT, 'build/luasession/luasession'),
  ardourRoot: ARDOUR_ROOT,
  libraryBaseDir: process.env.LIBRARY_BASE_DIR || resolve(ARDOUR_ROOT, 'library'),
  jobsDir: process.env.JOBS_DIR || '/tmp/ardour-jobs',
  maxQueueDepth: parseInt(process.env.MAX_QUEUE_DEPTH || '10', 10),
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10),
  jobTimeoutMs: parseInt(process.env.JOB_TIMEOUT_MS || '120000', 10),
  outputTtlMs: parseInt(process.env.OUTPUT_TTL_MS || '3600000', 10),
  maxTracks: parseInt(process.env.MAX_TRACKS || '64', 10),
  maxRegionsPerTrack: parseInt(process.env.MAX_REGIONS_PER_TRACK || '128', 10),
  maxPluginsPerTrack: parseInt(process.env.MAX_PLUGINS_PER_TRACK || '16', 10),
  maxJobSpecBytes: parseInt(process.env.MAX_JOB_SPEC_BYTES || '1048576', 10),
};
