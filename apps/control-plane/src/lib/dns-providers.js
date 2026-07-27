'use strict';

// Create the wildcard DNS record for the base domain, via the operator's DNS
// provider API, so the one genuinely manual step of the install can be skipped.
//
// Two rules this module holds to:
//
//   1. The API token is USED ONCE AND NEVER STORED. It is passed in, spent, and
//      dropped. Astrodock has no ongoing need for DNS write access, and a stored
//      token would be a standing credential capable of repointing the operator's
//      entire domain — a far larger prize than anything else the platform holds.
//
//   2. The zone is DISCOVERED, not guessed. Splitting "apps.example.com" into a
//      zone and a record name needs to know that "example.com" is registrable and
//      "apps" is not, which in general requires the public suffix list. Asking the
//      provider which zones this token can see, then taking the longest suffix
//      match, gets the right answer without bundling (and having to update) a copy
//      of the PSL — and it fails helpfully when the token cannot see the zone at all.

const PROVIDERS = {
  digitalocean: {
    label: 'DigitalOcean',
    tokenHint: 'A personal access token with write scope (API → Generate New Token).',
    async zones(token) {
      const res = await fetch('https://api.digitalocean.com/v2/domains?per_page=200', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401) throw new Error('DigitalOcean rejected that token.');
      if (!res.ok) throw new Error(`DigitalOcean API error (${res.status}).`);
      const body = await res.json();
      return (body.domains || []).map((d) => ({ id: d.name, name: d.name }));
    },
    async createRecord(token, zone, name, ip) {
      const res = await fetch(`https://api.digitalocean.com/v2/domains/${encodeURIComponent(zone.id)}/records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'A', name, data: ip, ttl: 300 })
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`DigitalOcean refused the record (${res.status}). ${body.slice(0, 200)}`);
      }
    }
  },

  cloudflare: {
    label: 'Cloudflare',
    tokenHint: 'An API token with Zone:DNS:Edit on the zone (My Profile → API Tokens).',
    async zones(token) {
      const res = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=200', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401 || res.status === 403) throw new Error('Cloudflare rejected that token.');
      if (!res.ok) throw new Error(`Cloudflare API error (${res.status}).`);
      const body = await res.json();
      return (body.result || []).map((z) => ({ id: z.id, name: z.name }));
    },
    async createRecord(token, zone, name, ip) {
      // Cloudflare wants the full record name, and proxying must be off: an orange-
      // clouded record would terminate TLS at Cloudflare, so Caddy could never
      // complete the HTTP-01 challenge for its own certificate.
      const fqdn = name === '@' ? zone.name : `${name}.${zone.name}`;
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'A', name: fqdn, content: ip, ttl: 300, proxied: false })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.success === false) {
        const msg = (body.errors || []).map((e) => e.message).join('; ') || `HTTP ${res.status}`;
        throw new Error(`Cloudflare refused the record: ${msg}`);
      }
    }
  }
};

function list() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({ key, label: p.label, tokenHint: p.tokenHint }));
}

// Longest zone whose name the base domain sits inside. "apps.example.com" against
// zones [example.com, other.com] gives example.com; against [apps.example.com]
// it gives the more specific one, which is what a delegated subdomain needs.
function pickZone(zones, baseDomain) {
  const candidates = zones.filter((z) => baseDomain === z.name || baseDomain.endsWith(`.${z.name}`));
  candidates.sort((a, b) => b.name.length - a.name.length);
  return candidates[0] || null;
}

// The record name relative to the zone: "*.apps" for apps.example.com in
// example.com, or plain "*" when the base domain IS the zone.
function wildcardRecordName(zone, baseDomain) {
  if (baseDomain === zone.name) return '*';
  return `*.${baseDomain.slice(0, -(zone.name.length + 1))}`;
}

/**
 * Create the wildcard A record. Returns { zone, record } on success.
 * Throws with an operator-readable message — these all surface in the wizard.
 */
async function createWildcard({ provider, token, baseDomain, ip }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown DNS provider: ${provider}`);
  if (!token) throw new Error('An API token is required.');
  if (!ip) throw new Error('This server\'s public IP is unknown, so there is nothing to point the record at.');

  const zones = await p.zones(token);
  if (!zones.length) throw new Error(`That token cannot see any domains in ${p.label}.`);

  const zone = pickZone(zones, baseDomain);
  if (!zone) {
    throw new Error(
      `${p.label} has no zone covering ${baseDomain}. Visible zones: ${zones.map((z) => z.name).join(', ')}. `
      + 'Add the domain to your DNS provider first, or create the record by hand.'
    );
  }

  const name = wildcardRecordName(zone, baseDomain);
  await p.createRecord(token, zone, name, ip);
  return { zone: zone.name, record: `${name}.${zone.name}` };
}

module.exports = { list, createWildcard, pickZone, wildcardRecordName, PROVIDERS };
