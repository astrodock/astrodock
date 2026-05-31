'use strict';

const Ajv = require('ajv/dist/2020');
const schema = require('./app.schema.json');

const RESERVED_PREFIX = 'TOOLSTEAD_';

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
const _validate = ajv.compile(schema);

/**
 * Validate a parsed app.json object against the schema.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(manifest) {
  const valid = _validate(manifest);
  if (valid) return { valid: true, errors: [] };
  const errors = (_validate.errors || []).map(formatError);
  return { valid: false, errors };
}

function formatError(err) {
  const where = err.instancePath || '(root)';
  if (err.keyword === 'additionalProperties') {
    return `${where}: unexpected property "${err.params.additionalProperty}"`;
  }
  if (err.keyword === 'pattern' && err.instancePath.includes('/env/')) {
    return `${where}: env var key must match ${err.params.pattern} (uppercase, and must NOT start with ${RESERVED_PREFIX})`;
  }
  if (err.keyword === 'required') {
    return `${where}: missing required field "${err.params.missingProperty}"`;
  }
  if (err.keyword === 'enum') {
    return `${where}: must be one of ${JSON.stringify(err.params.allowedValues)}`;
  }
  return `${where}: ${err.message}`;
}

/**
 * The reserved TOOLSTEAD_* environment variables that should be injected for the
 * given resource modes. This is the catalog (which vars exist + their metadata),
 * not their values — value computation lives in the control plane because it needs
 * runtime state (the internal DB password, the storage key, the base domain, ...).
 *
 * @param {{auth?:string, database?:string, storage?:string}} modes
 * @returns {Array<{key:string, secret:boolean, source:'auto'|'user-required', present:boolean}>}
 */
function reservedCatalog(modes = {}) {
  const auth = modes.auth || 'platform';
  const database = modes.database || 'none';
  const storage = modes.storage || 'none';

  const out = [
    { key: 'TOOLSTEAD_APP_SLUG', secret: false, source: 'auto' },
    { key: 'TOOLSTEAD_APP_NAME', secret: false, source: 'auto' },
    { key: 'TOOLSTEAD_APP_URL', secret: false, source: 'auto' },
    { key: 'TOOLSTEAD_BASE_DOMAIN', secret: false, source: 'auto' },
    { key: 'TOOLSTEAD_PORT', secret: false, source: 'auto' },
    { key: 'TOOLSTEAD_ENV', secret: false, source: 'auto' }
  ];

  if (database !== 'none') {
    const ext = database === 'external';
    out.push({ key: 'TOOLSTEAD_DATABASE_URL', secret: true, source: ext ? 'user-required' : 'auto' });
    out.push({ key: 'TOOLSTEAD_DATABASE_ENGINE', secret: false, source: 'auto' });
  }

  if (storage !== 'none') {
    const ext = storage === 'external';
    const src = ext ? 'user-required' : 'auto';
    out.push({ key: 'TOOLSTEAD_STORAGE_ENDPOINT', secret: false, source: src });
    out.push({ key: 'TOOLSTEAD_STORAGE_REGION', secret: false, source: src });
    out.push({ key: 'TOOLSTEAD_STORAGE_BUCKET', secret: false, source: src });
    out.push({ key: 'TOOLSTEAD_STORAGE_ACCESS_KEY', secret: false, source: src });
    out.push({ key: 'TOOLSTEAD_STORAGE_SECRET_KEY', secret: true, source: src });
    if (storage === 'internal') {
      out.push({ key: 'TOOLSTEAD_STORAGE_PREFIX', secret: false, source: 'auto' });
    }
  }

  if (auth === 'platform') {
    out.push({ key: 'TOOLSTEAD_AUTH_URL', secret: false, source: 'auto' });
    out.push({ key: 'TOOLSTEAD_APP_ID', secret: false, source: 'auto' });
    out.push({ key: 'TOOLSTEAD_APP_SECRET', secret: true, source: 'auto' });
    out.push({ key: 'TOOLSTEAD_APP_JWT_SECRET', secret: true, source: 'auto' });
  }

  return out;
}

/**
 * Reserved variables the OPERATOR must supply a value for before deploy (external modes).
 * @param {{database?:string, storage?:string}} modes
 * @returns {string[]} reserved keys that are user-required
 */
function userRequiredReservedKeys(modes = {}) {
  return reservedCatalog(modes)
    .filter((v) => v.source === 'user-required')
    .map((v) => v.key);
}

module.exports = {
  schema,
  validate,
  RESERVED_PREFIX,
  reservedCatalog,
  userRequiredReservedKeys
};
