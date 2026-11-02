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

// Step-up re-auth guesses a factor from inside a signed-in session, so an IP
// limit is the wrong key: whoever holds a stolen session can change IP. Keyed on
// the account, and only failures count, so confirming normally never trips it.
// Runs after requireAdmin, which is what sets req.auth.
const reauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `reauth:${req.auth?.sub || req.auth?.sessionId || 'unknown'}`,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Wait a few minutes, then try again.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Redeeming a mobile sign-in code. A code is 32 random bytes and dies on first
// use, so this is about load, not guessing; the same budget as /verify.
const mobileTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many sign-in attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// POST /notify: 60 per app per person per hour (MOBILE_DESIGN.md). Runs after
// the app secret and the person are checked, which set req.notify, so a caller
// without the secret cannot spend another app's budget. Only successes count.
const notifyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `notify:${req.notify?.app?.id || 'unknown'}:${req.notify?.user?.id || 'unknown'}`,
  skipFailedRequests: true,
  message: { error: 'Too many notifications to this person from this app. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { mobileTokenLimiter, notifyLimiter, reauthLimiter, launchLimiter, verifyLimiter, adminLoginLimiter, accountLimiter, deployLimiter, pageDataLimiter, pageLoginLimiter, feedbackLimiter };
