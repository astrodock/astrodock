const rateLimit = require('express-rate-limit');

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 attempts per window per IP
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

const accountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// Caps deploy triggers (esp. the large deploy-local upload) to blunt resource-exhaustion.
const deployLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: { error: 'Too many deploys, slow down' },
  standardHeaders: true,
  legacyHeaders: false
});

// Pages: cap data-blob writes and page-login attempts (public, untrusted surface).
const pageDataLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: { error: 'Too many writes, slow down' },
  standardHeaders: true,
  legacyHeaders: false
});
const pageLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// Feedback intake is reachable from a browser without an operator credential,
// so it is the one endpoint a stranger can hammer. Generous enough that a person
// filing three bugs in a row never notices, tight enough that the table cannot
// be filled from a laptop.
const feedbackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { error: 'That is a lot of feedback at once. Try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Signing in from a trusted launcher. Everyone in one office shares an IP and
// opens apps all day, so this is looser than the password form's limit; each
// pass is still single-use and signed.
const launchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: 'Too many sign-ins from here, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { launchLimiter, verifyLimiter, adminLoginLimiter, accountLimiter, deployLimiter, pageDataLimiter, pageLoginLimiter, feedbackLimiter };
