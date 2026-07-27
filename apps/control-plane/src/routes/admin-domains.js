'use strict';

// Global domains roll-up: every custom domain across all apps + the base-domain
// foundation + the automatic subdomains. Admin JWT or a deploy-scoped token.

const express = require('express');
const { eq, desc } = require('drizzle-orm');
const config = require('../config');
const { db, schema } = require('../db');
const { requireScope } = require('../middleware/auth');
const domainsLib = require('../lib/domains');

const router = express.Router();
router.use(requireScope('apps:read'));

router.get('/', async (req, res, next) => {
  try {
    const rows = await db.select({
      id: schema.customDomains.id, hostname: schema.customDomains.hostname, status: schema.customDomains.status,
      isPrimary: schema.customDomains.isPrimary, redirectToCanonical: schema.customDomains.redirectToCanonical,
      verificationToken: schema.customDomains.verificationToken, lastCheckedAt: schema.customDomains.lastCheckedAt,
      appSlug: schema.apps.slug, appName: schema.apps.name
    }).from(schema.customDomains)
      .innerJoin(schema.apps, eq(schema.customDomains.appId, schema.apps.id))
      .orderBy(desc(schema.customDomains.createdAt));

    const apps = await db.select({ slug: schema.apps.slug, name: schema.apps.name, subdomain: schema.apps.subdomain })
      .from(schema.apps).where(eq(schema.apps.provisioned, true));

    res.json({
      baseDomain: config.baseDomain,
      publicIp: config.publicIp || null,
      tlsMode: config.tlsMode,
      custom: rows.map((d) => ({ ...d, records: domainsLib.dnsRecords(d) })),
      subdomains: apps.map((a) => ({ host: `${a.subdomain}.${config.baseDomain}`, app: a.name, slug: a.slug })),
      platform: [
        { host: `${config.adminSubdomain}.${config.baseDomain}`, label: 'Your dashboard' },
        { host: config.pages.host, label: 'Your Pages' }
      ]
    });
  } catch (err) { next(err); }
});

module.exports = router;
