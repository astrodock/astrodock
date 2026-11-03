'use strict';

// Open a page for the person at the keyboard: an approval, or `astrodock login`.
//
// Best effort, and never the only way: the URL is always printed as well, for
// an agent in a sandbox or on a remote machine with no browser to open.
// ASTRODOCK_NO_BROWSER=1 (or --no-browser) turns it off.

const { spawn } = require('node:child_process');

// Only a plain http(s) address is opened. The URL comes from a server (an
// approval link, a sign-in page), and `open` accepts any scheme or file path,
// while Windows' `cmd /c start` reads & and | as the start of another command.
function safeUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return null;
  const href = u.href;
  return /["'`<>\s]/.test(href) ? null : href;
}

function openUrl(raw) {
  if (process.env.ASTRODOCK_NO_BROWSER) return false;
  const url = safeUrl(raw);
  if (!url) return false;
  let cmd;
  let args;
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  // rundll32 hands the address to the default browser without a shell.
  else if (process.platform === 'win32') { cmd = 'rundll32'; args = ['url.dll,FileProtocolHandler', url]; }
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

module.exports = { openUrl, safeUrl };
