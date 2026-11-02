'use strict';

// Fixed-window counters in memory. The relay runs as one process, so there is
// nothing to share; a restart resets the windows, which only ever lets a
// little more through.

function createLimiter({ max, windowMs }) {
  const windows = new Map();

  // Expired windows are dropped on a timer so a stream of one-off IPs cannot
  // grow the map without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
  }, Math.max(windowMs, 1000));
  sweep.unref();

  // Counts one hit for key. Returns true while the key is within its limit.
  function hit(key) {
    const now = Date.now();
    let w = windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      windows.set(key, w);
    }
    w.count += 1;
    return w.count <= max;
  }

  function close() { clearInterval(sweep); }

  return { hit, close, max, windowMs };
}

module.exports = { createLimiter };
