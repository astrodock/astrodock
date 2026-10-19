'use strict';

// POST /launch: sign someone in from a trusted launcher and send them to the app.
// See lib/launch.js for the pass format and what trusting a launcher means.
//
// Mounted at the root like /authorize, and excluded from the CORS middleware:
// the pass arrives as a top-level form POST from the launcher's origin, which
// is not one of this platform's own hosts. The Origin check in redeemPass is
// what stands in for CORS here.

const express = require('express');
const { eq } = require('drizzle-orm');
const { db, schema } = require('../db');
const userSession = require('../lib/user-session');
const { errorPage } = require('../lib/auth-pages');
const { emitEvent } = require('../lib/events');
const { appUrl } = require('../lib/env-compute');
const launch = require('../lib/launch');
const { launchLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

function logAttempt(email, appId, result, ip) {
  db.insert(schema.authLogs).values({ email: email || '', appId: appId || '', result, ip: ip || '' }).catch(() => {});
}

router.post('/launch', launchLimiter, express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
  const ip = req.ip || '';
  // The pass is a credential for the next few seconds; nothing should keep this page.
  res.setHeader('Cache-Control', 'no-store');

  if (!await launch.launcher()) {
    return res.status(404).type('html').send(errorPage('Not available', 'Signing in from another system is not set up on this server.'));
  }

  let pass;
  try {
    pass = await launch.redeemPass(req.body?.token, { origin: req.get('origin') });
  } catch (err) {
    if (!(err instanceof launch.LaunchError)) throw err;
    logAttempt('', '', 'LAUNCH_REFUSED', ip);
    return res.status(err.status).type('html').send(errorPage(err.title, err.message));
  }

  const [app] = await db.select().from(schema.apps).where(eq(schema.apps.slug, pass.app)).limit(1);
  if (!app) {
    logAttempt(pass.email, pass.app, 'LAUNCH_UNKNOWN_APP', ip);
    return res.status(404).type('html').send(errorPage('Unknown app', 'That app is not on this server.'));
  }
  if (!app.provisioned) {
    logAttempt(pass.email, app.slug, 'LAUNCH_NOT_READY', ip);
    return res.status(409).type('html').send(errorPage('Not ready yet', `${app.name} has not been set up yet.`));
  }

  // A public app needs no account. Send them straight there.
  if (app.authMode !== 'platform') return res.redirect(303, appUrl(app));

  let result;
  try {
    result = await launch.resolveUser(pass, app);
  } catch (err) {
    if (!(err instanceof launch.LaunchError)) throw err;
    logAttempt(pass.email, app.slug, 'LAUNCH_REFUSED', ip);
    return res.status(err.status).type('html').send(errorPage(err.title, err.message));
  }
  const { user, created, granted } = result;

  userSession.set(res, user);
  logAttempt(user.email, app.slug, 'SUCCESS_LAUNCH', ip);
  if (created || granted) {
    emitEvent({
      category: 'audit',
      type: created ? 'user.created_by_launch' : 'user.access_granted_by_launch',
      severity: 'info',
      message: created
        ? `${user.email} was added by ${pass.issuer} and given access to ${app.slug}`
        : `${user.email} was given access to ${app.slug} by ${pass.issuer}`,
      actorType: 'system', actor: pass.issuer, targetType: 'user', targetId: user.id, ip
    }).catch(() => {});
  }

  // The app's own sign-in now completes without a form: /authorize finds the
  // platform session and an existing grant, and hands straight back a code.
  // 303 so the browser follows with a GET rather than re-posting the pass.
  res.redirect(303, `${appUrl(app)}${app.authLoginPath || '/api/login'}`);
});

module.exports = router;
