'use strict';

// `astrodock server …`: the machine the platform runs on.
//
//   server disk          what the disk holds
//   server free-space    remove old images and build cache (needs platform:write)
//   server run "<cmd>"   run a command as root on the server (needs server:exec)
//
// `run` needs a key carrying server:exec. Only an owner can create one, it covers
// the whole platform and it expires within 24 hours. Every command is recorded
// in the platform's audit trail before it runs.

function gb(bytes) { return `${((bytes || 0) / 1073741824).toFixed(1)} GB`; } // binary, like df -h

async function cmdServer(client, positional, die) {
  const [sub, ...rest] = positional;

  if (sub === 'disk') {
    const { status, json } = await client.request('GET', '/admin/server/disk');
    if (status >= 400) die(json?.error || `disk failed (${status})`);
    const d = json.disk || {};
    console.log(`Disk: ${d.usedPercent}% used, ${gb(d.used)} of ${gb(d.total)}, ${gb(d.available)} free`);
    for (const r of json.docker || []) {
      console.log(`  ${String(r.type).padEnd(14)} ${String(r.total).padStart(4)} total  ${gb(r.size).padStart(9)}  ${gb(r.reclaimable).padStart(9)} reclaimable`);
    }
    const versions = (json.platformVersions || []).map((v) => v.tag).filter((t) => t !== 'latest');
    console.log(`Astrodock versions stored: ${versions.length}${json.runningVersion ? ` (running ${json.runningVersion})` : ''}`);
    return;
  }

  if (sub === 'free-space') {
    const { status, json } = await client.request('POST', '/admin/server/free-space');
    if (status >= 400) die(json?.error || `free-space failed (${status})`);
    console.log(`Freed ${gb(json.freedBytes)}. Removed ${(json.removed || []).length} image(s).`);
    for (const r of json.removed || []) console.log(`  ${r}`);
    return;
  }

  if (sub === 'run') {
    const command = rest.join(' ').trim();
    if (!command) die('usage: astrodock server run "<command>"');
    let exitCode = 0;
    const { status, json } = await client.stream('/admin/server/exec', { command }, (event, data) => {
      if (event === 'stdout') process.stdout.write(String(data));
      else if (event === 'stderr') process.stderr.write(String(data));
      else if (event === 'exit') exitCode = data && data.code != null ? data.code : 1;
      else if (event === 'error') { process.stderr.write(`${data}\n`); exitCode = 1; }
    });
    if (status >= 400) die(json?.error || `run failed (${status})`);
    process.exitCode = exitCode;
    return;
  }

  die('usage: astrodock server disk | free-space | run "<command>"');
}

module.exports = { cmdServer };
