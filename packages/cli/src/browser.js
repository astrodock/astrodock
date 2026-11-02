'use strict';

// Open a page for the person at the keyboard: an approval, or `astrodock login`.
//
// Best effort, and never the only way: the URL is always printed as well, for
// an agent in a sandbox or on a remote machine with no browser to open.
// ASTRODOCK_NO_BROWSER=1 (or --no-browser) turns it off.

const { spawn } = require('node:child_process');

function openUrl(url) {
  if (process.env.ASTRODOCK_NO_BROWSER) return false;
  let cmd;
  let args;
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url]; }
  else {
    // No display means no browser to open; xdg-open would fail or pick a text one.
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
    cmd = 'xdg-open'; args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { openUrl };
