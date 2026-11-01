'use strict';

// Internal object-storage provisioner.
//
// Preferred (real isolation): each app gets its OWN bucket + a dedicated S3
// access key scoped to that bucket, minted in SeaweedFS via `weed shell
// s3.configure` (run in the objectstore container through the Docker socket).
// Configuring identities also locks down anonymous access, so the platform's
// own key is registered as an admin identity.
//
// There is no fallback. It used to hand the app the platform's own Admin key plus a
// prefix when minting failed, which made every such app able to read and write
// every bucket — and one known trigger (a renamed compose project) failed every
// time, silently. A failure to mint is now a provisioning error the operator sees.

const { execFileSync } = require('child_process');
const { S3Client, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } = require('@aws-sdk/client-s3');
const config = require('../config');
const { generateSecretHex } = require('../lib/ids');
const { encryptSecret, decryptSecret } = require('../lib/crypto');

const { containerFor } = require('../runner/containers');

// The container that runs `weed` with a master. In the current compose that is the
// `seaweed` service, which apps cannot reach; in older compose files it is the
// single `objectstore` service.
function weedContainer() {
  return containerFor({
    env: 'ASTRODOCK_OBJECTSTORE_CONTAINER',
    services: ['seaweed', 'objectstore'],
    legacy: 'astrodock-objectstore-1'
  });
}

function s3(creds) {
  return new S3Client({
    endpoint: config.objectstore.endpoint,
    region: config.objectstore.region,
    credentials: creds || { accessKeyId: config.objectstore.accessKey, secretAccessKey: config.objectstore.secretKey },
    forcePathStyle: true
  });
}

// Run a `weed shell` command inside the storage container. Throws on failure.
//
// The command goes down stdin. It carries secret keys, and anything on a command
// line is readable by every process on the box through /proc/<pid>/cmdline — Node
// apps share the runner's process table.
function weedShell(command) {
  return execFileSync('docker', ['exec', '-i', weedContainer(), 'weed', 'shell'], {
    encoding: 'utf8', timeout: 15000, input: `${command}\n`
  });
}

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
    // create the bucket with the ADMIN key (the per-app key is scoped to Read/Write
    // within the bucket and can't create it)…
    await ensureBucket(bucket);
    // …then mint a per-app identity scoped to ONLY this app's bucket
    weedShell(`s3.configure -user ${app.slug} -access_key ${accessKey} -secret_key ${secretKey} -buckets ${bucket} -actions Read,Write,List,Tagging -apply`);
    return {
      storageBucket: bucket,
      storagePrefix: '',
      storageAccessKey: accessKey,
      storageSecretKey: encryptSecret(secretKey),
      scoped: true
    };
  } catch (err) {
    console.error(`[storage] could not mint a scoped storage key for ${app.slug}: ${err.message}`);
    throw new Error(`Could not create a storage key for this app (${err.message.split('\n')[0]}). `
      + 'Check that the runner can reach the object store container through the Docker socket.');
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
