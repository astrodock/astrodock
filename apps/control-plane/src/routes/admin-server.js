'use strict';

// The Server page: what the disk holds, freeing space, and the server terminal.
// The work happens in the runner (runner/server-ops.js), which holds the Docker
// socket; this router decides who may ask and records what was asked.

const express = require('express');
const { requirePermission, callerHasScope } = require('../middleware/auth');
const { runner } = require('../runner/client');
const { emitEvent, actorFromAuth } = require('../lib/events');

const router = express.Router();

router.get('/disk', requirePermission('settings:read'), async (req, res) => {
  const r = await runner.serverDisk().catch((e) => ({ status: e.status || 503, body: { error: e.message } }));
  res.status(r.status).json(r.body || {});
});

router.post('/free-space', requirePermission('platform:write'), async (req, res) => {
  const r = await runner.serverFreeSpace().catch((e) => ({ status: e.status || 503, body: { error: e.message } }));
  if (r.status === 200 && r.body) {
    const freedMb = Math.round((r.body.freedBytes || 0) / 1048576);
    emitEvent({
      category: 'audit', type: 'server.space_freed', severity: 'info',
      ...actorFromAuth(req.auth), ip: req.ip,
      message: `Freed ${freedMb >= 1024 ? `${(freedMb / 1024).toFixed(1)} GB` : `${freedMb} MB`} of disk`
        + ` (${(r.body.removed || []).length} image(s) removed)`,
      meta: { removed: r.body.removed, freedBytes: r.body.freedBytes }
    }).catch(() => {});
  }
  res.status(r.status).json(r.body || {});
});

// Whether the terminal exists on this platform, and whether this caller may use
// it. The page shows it only when both are true.
router.get('/exec/enabled', requirePermission('settings:read'), async (req, res) => {
  const r = await runner.serverExecEnabled().catch(() => ({ body: { enabled: false } }));
  res.json({ enabled: !!(r.body && r.body.enabled), allowed: callerHasScope(req.auth, 'server:exec') });
});

router.post('/exec', requirePermission('server:exec'), async (req, res) => {
  const command = req.body && req.body.command;
  if (!command || !String(command).trim()) return res.status(400).json({ error: 'command is required' });

  // Recorded before it runs, with the text and who ran it (a person, or which
  // key). A root shell nobody can review afterwards is worse than none.
  await emitEvent({
    category: 'audit', type: 'server.exec', severity: 'warning',
    ...actorFromAuth(req.auth), ip: req.ip, targetType: 'server', targetId: 'host',
    message: `Ran on the server: ${String(command).slice(0, 500)}`
  }).catch(() => {});

  let upstream;
  try { upstream = await runner.serverExecStream(String(command)); }
  catch (e) { return res.status(e.status || 503).json({ error: e.message }); }

  if (!upstream.ok && upstream.headers.get('content-type')?.includes('json')) {
    const body = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json(body);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const reader = upstream.body.getReader();
  req.on('close', () => { reader.cancel().catch(() => {}); });
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
});

module.exports = router;
