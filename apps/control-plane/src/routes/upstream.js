'use strict';

// Receiving capability feedback from other Astrodock instances. Only the
// project's own instance turns this on (ASTRODOCK_ACCEPT_UPSTREAM_FEEDBACK=on);
// everywhere else it answers 404. Public by necessity: the senders are other
// people's servers. Rate-limited per address, size-capped, stored only.

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const feedback = require('../lib/artifacts/feedback');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: { error: 'Too many submissions, try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

const accepting = (req, res, next) => {
  if (config.artifacts.acceptUpstreamFeedback) return next();
  require('../lib/settings').getSetting('artifacts.accept_upstream_feedback', 'off')
    .then((v) => (v === 'on' ? next() : res.status(404).json({ error: 'Not found' })))
    .catch(() => res.status(404).json({ error: 'Not found' }));
};

router.post('/capability-feedback', accepting,
  limiter, express.json({ limit: '96kb' }), async (req, res) => {
    try {
      await feedback.receive(req.body);
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' });
    }
  });

module.exports = router;
