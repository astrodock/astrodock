'use strict';

// The two public endpoints `astrodock login` talks to. See lib/cli-login.
//
// Public by necessity: the CLI has no credential yet, which is the point. A
// start creates nothing a stranger can use (a person still has to approve it),
// and a poll needs both the device code and the verifier.

const express = require('express');
const rateLimit = require('express-rate-limit');
const cliLogin = require('../lib/cli-login');

const router = express.Router();

const startLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-ins started from here. Try again later.' }
});

// The CLI polls every few seconds for up to fifteen minutes.
const pollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Polling too fast.', code: 'slow_down' }
});

function fail(res, err) {
  return res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
}

router.post('/login/start', startLimiter, async (req, res) => {
  try {
    const { codeChallenge, client, manifest } = req.body || {};
    res.status(201).json(await cliLogin.start({ codeChallenge, client, manifest }));
  } catch (err) { fail(res, err); }
});

router.post('/login/poll', pollLimiter, async (req, res) => {
  try {
    const { deviceCode, codeVerifier } = req.body || {};
    const out = await cliLogin.poll({ deviceCode, codeVerifier });
    const status = { approved: 200, pending: 202, denied: 403, expired: 410, consumed: 410 }[out.status] || 200;
    res.status(status).json(out);
  } catch (err) { fail(res, err); }
});

module.exports = router;
