/**
 * Parse analysis output from arlua stdout.
 * The Lua script emits lines like: ANALYSIS_JSON:{"track":"name","peak_db":-3.1,...}
 * The special track name "__master__" is the master bus analysis.
 */
export function parseAnalysisOutput(stdout) {
  const lines = stdout.split('\n');
  const master = { peak_db: null, rms_db: null };
  const tracks = [];
  let foundMaster = false;

  for (const line of lines) {
    if (!line.startsWith('ANALYSIS_JSON:')) continue;
    const json = line.slice('ANALYSIS_JSON:'.length);
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }

    if (data.track === '__master__') {
      Object.assign(master, data);
      delete master.track;
      foundMaster = true;
    } else {
      const entry = { name: data.track, ...data };
      delete entry.track;
      tracks.push(entry);
    }
  }

  return { master: foundMaster ? master : null, tracks };
}
