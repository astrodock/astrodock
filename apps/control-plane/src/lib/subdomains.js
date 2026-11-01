'use strict';

const config = require('../config');

// Subdomains may not collide with platform hosts or be invalid DNS labels.
//
// Each of these is refused for a reason worth stating, because "reserved" on its
// own tells someone nothing about whether the name will ever be available. The
// list is served to the dashboard so the form can show it up front, rather than
// letting people find out one rejected name at a time.
const RESERVED_SUBDOMAINS = new Map([
  ['admin', 'the dashboard'],
  ['pages', 'hosted Pages'],
  ['auth', 'reserved for hosted sign-in'],
  ['api', 'reserved for the platform API'],
  ['www', 'redirects to your main address — set that under Settings'],
  ['mail', 'clashes with mail servers and MX records'],
  ['ftp', 'clashes with file-transfer conventions'],
  [config.adminSubdomain, 'the dashboard'],
  [config.authSubdomain, 'reserved for hosted sign-in'],
  [config.pages.subdomain, 'hosted Pages']
].filter(([k]) => k));

function reservedReason(v) { return RESERVED_SUBDOMAINS.get(v) || null; }

function validSubdomain(v) {
  return typeof v === 'string'
    && v.length <= 40
    && /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(v)   // valid label, no leading/trailing hyphen
    && !RESERVED_SUBDOMAINS.has(v);
}

module.exports = { RESERVED_SUBDOMAINS, reservedReason, validSubdomain };
