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

  // Sessions
  allowGui: process.env.ALLOW_GUI !== 'false',  // default true; set ALLOW_GUI=false in production
  maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '5', 10),
  sessionIdleTimeoutMs: parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || '1800000', 10),
  sessionStartupTimeoutMs: parseInt(process.env.SESSION_STARTUP_TIMEOUT_MS || '30000', 10),
  sessionHealthIntervalMs: parseInt(process.env.SESSION_HEALTH_INTERVAL_MS || '30000', 10),
  sessionAutoSaveIntervalMs: parseInt(process.env.SESSION_AUTO_SAVE_MS || '300000', 10),
  mcpPortRangeStart: parseInt(process.env.MCP_PORT_RANGE_START || '4821', 10),
  mcpPortRangeEnd: parseInt(process.env.MCP_PORT_RANGE_END || '4920', 10),
  luasessionBin: resolve(ARDOUR_ROOT, 'build/luasession/luasession'),
  ardourGuiBin: process.env.ARDOUR_GUI_BIN || resolve(ARDOUR_ROOT, 'build/gtk2_ardour/ardour-9.2.326'),
  mcpHostLua: resolve(ARDOUR_ROOT, 'api-service/lua/mcp_host.lua'),
  createSessionLua: resolve(ARDOUR_ROOT, 'api-service/lua/create_session.lua'),
  sessionsDir: process.env.SESSIONS_DIR || '/tmp/ardour-sessions',
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || '104857600', 10),
  actionQueueDepth: parseInt(process.env.ACTION_QUEUE_DEPTH || '20', 10),
  actionQueueTimeoutMs: parseInt(process.env.ACTION_QUEUE_TIMEOUT_MS || '120000', 10),
  actionTimeoutMs: parseInt(process.env.ACTION_TIMEOUT_MS || '10000', 10),
  luaEvalMaxBytes: parseInt(process.env.LUA_EVAL_MAX_BYTES || '65536', 10),
  luaEvalTimeoutMs: parseInt(process.env.LUA_EVAL_TIMEOUT_MS || '30000', 10),
  logRingBufferSize: parseInt(process.env.LOG_RING_BUFFER_SIZE || '10000', 10),
  analysisTimeoutMs: parseInt(process.env.ANALYSIS_TIMEOUT_MS || '600000', 10),
  maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || '100', 10),
  maxSessionUploadBytes: parseInt(process.env.MAX_SESSION_UPLOAD_BYTES || '1073741824', 10),
  maxSessionExportBytes: parseInt(process.env.MAX_SESSION_EXPORT_BYTES || '2147483648', 10),
  stretchProgressPollMs: parseInt(process.env.STRETCH_PROGRESS_POLL_MS || '1000', 10),
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
  audioValidatorBin: process.env.AUDIO_VALIDATOR_BIN
    || resolve(ARDOUR_ROOT, 'build/tools/audio-validator/audio-validator'),
};
