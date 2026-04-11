import { spawn } from 'child_process';
import { mkdir, writeFile, readdir, stat, rm } from 'fs/promises';
import { resolve, join } from 'path';
import { config } from '../config.js';

function buildArdourEnv() {
  const TOP = config.ardourRoot;
  const libs = join(TOP, 'build/libs');

  const surfaceDirs = [
    'osc', 'faderport8', 'faderport', 'generic_midi', 'tranzport',
    'powermate', 'mackie', 'us2400', 'wiimote', 'push2', 'maschine2',
    'cc121', 'launch_control_xl', 'contourdesign', 'websockets',
    'mcp_http', 'console1', 'launchpad_pro', 'launchpad_x', 'launchkey_4',
  ].map(s => join(libs, 'surfaces', s)).join(':');

  const backendDirs = [
    'jack', 'dummy', 'alsa', 'coreaudio', 'portaudio', 'pulseaudio',
  ].map(b => join(libs, 'backends', b)).join(':');

  const ldPaths = [
    'tk/ydk-pixbuf', 'tk/ztk', 'tk/ydk', 'tk/ytk', 'tk/ztkmm',
    'tk/ydkmm', 'tk/ytkmm', 'tk/suil', 'ptformat', 'qm-dsp',
    'vamp-sdk', 'surfaces', 'ctrl-interface/control_protocol',
    'ctrl-interface/midi_surface', 'ardour', 'midi++2', 'pbd',
    'rubberband', 'soundtouch', 'aaf', 'gtkmm2ext', 'widgets',
    'appleutility', 'taglib', 'evoral', 'evoral/src/libsmf',
    'audiographer', 'temporal', 'libltc', 'canvas', 'waveview',
    'ardouralsautil',
  ].map(p => join(libs, p)).join(':');

  const existingVamp = process.env.VAMP_PATH ? `:${process.env.VAMP_PATH}` : '';
  const existingLd = process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : '';

  return {
    ...process.env,
    ARDOUR_SURFACES_PATH: surfaceDirs,
    ARDOUR_PANNER_PATH: join(libs, 'panners'),
    ARDOUR_DATA_PATH: `${join(TOP, 'share')}:${join(TOP, 'build')}:${join(TOP, 'gtk2_ardour')}:${join(TOP, 'build/gtk2_ardour')}`,
    ARDOUR_MIDIMAPS_PATH: join(TOP, 'share/midi_maps'),
    ARDOUR_MIDI_PATCH_PATH: join(TOP, 'share/patchfiles'),
    ARDOUR_EXPORT_FORMATS_PATH: join(TOP, 'share/export'),
    ARDOUR_THEMES_PATH: join(TOP, 'gtk2_ardour/themes'),
    ARDOUR_BACKEND_PATH: backendDirs,
    ARDOUR_CONFIG_PATH: `${TOP}:${join(TOP, 'gtk2_ardour')}:${join(TOP, 'build')}:${join(TOP, 'build/gtk2_ardour')}`,
    ARDOUR_DLL_PATH: libs,
    GTK_PATH: `${join(process.env.HOME || '~', '.ardour3')}:${join(libs, 'clearlooks-newer')}`,
    VAMP_PATH: `${join(libs, 'vamp-plugins')}:${join(libs, 'vamp-pyin')}${existingVamp}`,
    GTK2_RC_FILES: '/nonexistent',
    LD_LIBRARY_PATH: `${ldPaths}${existingLd}`,
    DYLD_FALLBACK_LIBRARY_PATH: `${ldPaths}${existingLd}`,
  };
}

export async function executeJob(jobId, luaScript, logger) {
  const jobDir = resolve(config.jobsDir, jobId);
  const exportDir = join(jobDir, 'export');
  const scriptPath = join(jobDir, 'job.lua');

  await mkdir(exportDir, { recursive: true });
  await writeFile(scriptPath, luaScript, 'utf8');

  logger.info?.(`[executor] Starting job ${jobId}`);

  const env = buildArdourEnv();

  return new Promise((resolveP, rejectP) => {
    const child = spawn(config.arluaBin, [scriptPath], {
      env,
      cwd: jobDir,
      timeout: config.jobTimeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      rejectP(new Error(`Failed to spawn arlua: ${err.message}`));
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        rejectP(new Error(
          `arlua exited with code ${code}\nstderr: ${stderr}\nstdout: ${stdout}`
        ));
        return;
      }

      try {
        const outputs = [];
        let entries;
        try {
          entries = await readdir(exportDir);
        } catch {
          entries = [];
        }

        for (const filename of entries) {
          const filePath = join(exportDir, filename);
          const fileStat = await stat(filePath);
          if (fileStat.isFile()) {
            outputs.push({
              filename,
              path: filePath,
              size: fileStat.size,
            });
          }
        }

        logger.info?.(`[executor] Job ${jobId} complete, ${outputs.length} output(s)`);
        resolveP({ outputs, stdout, stderr });
      } catch (err) {
        rejectP(new Error(`Failed to scan outputs: ${err.message}`));
      }
    });
  });
}

export async function cleanupJob(jobId) {
  const jobDir = resolve(config.jobsDir, jobId);
  await rm(jobDir, { recursive: true, force: true });
}
