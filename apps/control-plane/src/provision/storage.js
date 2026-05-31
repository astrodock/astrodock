'use strict';

// Internal object-storage provisioner.
//
// Preferred (real isolation): each app gets its OWN bucket + a dedicated S3
// access key scoped to that bucket, minted in SeaweedFS via `weed shell
// s3.configure` (run in the objectstore container through the Docker socket).
// Configuring identities also locks down anonymous access, so the platform's
// own key is registered as an admin identity.
//
// Fallback (if identities can't be minted — e.g. no socket / unsupported store):
// the shared platform key + a per-app key prefix, exactly as before. The injected
// env var set is identical either way, so app code never changes. See DECISIONS B3.

const { execFileSync } = require('child_process');
const { S3Client, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const config = require('../config');
const { generateSecretHex } = require('../lib/ids');
const { encryptSecret, decryptSecret } = require('../lib/crypto');

const CONTAINER = process.env.TOOLSTEAD_OBJECTSTORE_CONTAINER || 'toolstead-objectstore-1';

function s3(creds) {
  return new S3Client({
    endpoint: config.objectstore.endpoint,
    region: config.objectstore.region,
    credentials: creds || { accessKeyId: config.objectstore.accessKey, secretAccessKey: config.objectstore.secretKey },
    forcePathStyle: true
  });
}

// Run a `weed shell` command inside the objectstore container. Throws on failure.
function weedShell(command) {
  // `docker exec -i <container> sh -c 'echo "<cmd>" | weed shell'`
  const script = `echo ${shq(command)} | weed shell 2>&1`;
  return execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-c', script], { encoding: 'utf8', timeout: 15000 });
}
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

let adminEnsured = false;
function ensureAdminIdentity() {
  if (adminEnsured) return;
  weedShell(`s3.configure -user admin -access_key ${config.objectstore.accessKey} -secret_key ${config.objectstore.secretKey} -actions Admin -apply`);
  adminEnsured = true;
}

async function ensureBucket(bucket, creds) {
  const c = s3(creds);
  try { await c.send(new HeadBucketCommand({ Bucket: bucket })); }
  catch { await c.send(new CreateBucketCommand({ Bucket: bucket })); }
  finally { c.destroy(); }
}

// Provision storage for an app. Returns the fields stored on the app row.
async function provisionStorage(app) {
  const bucket = app.slug; // S3-legal: slugs are [a-z0-9-]
  // reuse stored creds on re-provision
  const accessKey = app.storageAccessKey || `ak_${app.slug}_${generateSecretHex(6)}`;
  const secretKey = app.storageSecretKey ? decryptSecret(app.storageSecretKey) : generateSecretHex(20);

  try {
    ensureAdminIdentity();
    // scope this identity to ONLY this app's bucket
    weedShell(`s3.configure -user ${app.slug} -access_key ${accessKey} -secret_key ${secretKey} -buckets ${bucket} -actions Read,Write,List,Tagging -apply`);
    await ensureBucket(bucket, { accessKeyId: accessKey, secretAccessKey: secretKey });
    return {
      storageBucket: bucket,
      storagePrefix: '',
      storageAccessKey: accessKey,
      storageSecretKey: encryptSecret(secretKey),
      scoped: true
    };
  } catch (err) {
    // fallback: shared platform key + per-app prefix in the shared bucket
    console.error(`[storage] scoped key provisioning unavailable (${err.message.split('\n')[0]}); falling back to shared key + prefix`);
    await ensureBucket(config.objectstore.bucket);
    return {
      storageBucket: config.objectstore.bucket,
      storagePrefix: `${app.slug}/`,
      storageAccessKey: null,
      storageSecretKey: null,
      scoped: false
    };
  }
}

// Delete an app's objects (and its bucket/identity when scoped). Best-effort.
async function dropStorage(app) {
  const scoped = !!app.storageAccessKey;
  const bucket = app.storageBucket || config.objectstore.bucket;
  const prefix = app.storagePrefix || '';
  const creds = scoped
    ? { accessKeyId: app.storageAccessKey, secretAccessKey: decryptSecret(app.storageSecretKey) }
    : undefined;
  const c = s3(creds);
  try {
    let token;
    do {
      const list = await c.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      const objs = (list.Contents || []).map((o) => ({ Key: o.Key }));
      if (objs.length) await c.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs } }));
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    if (scoped) { try { await c.send(new DeleteBucketCommand({ Bucket: bucket })); } catch { /* not empty / not supported */ } }
  } finally {
    c.destroy();
  }
  if (scoped) { try { weedShell(`s3.configure -user ${app.slug} -delete -apply`); } catch { /* best effort */ } }
}

module.exports = { provisionStorage, dropStorage, ensureBucket };
