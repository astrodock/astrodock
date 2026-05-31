'use strict';

// Internal object-storage provisioner. v1: one shared bucket on the bundled
// SeaweedFS store; each app gets a per-app key PREFIX. The injected env var set
// is identical to the external/per-app-key path, so app code never changes when
// this is upgraded to truly scoped keys later. See DECISIONS.md (B3).

const { S3Client, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const config = require('../config');

function client() {
  return new S3Client({
    endpoint: config.objectstore.endpoint,
    region: config.objectstore.region,
    credentials: {
      accessKeyId: config.objectstore.accessKey,
      secretAccessKey: config.objectstore.secretKey
    },
    forcePathStyle: true
  });
}

async function ensureBucket() {
  const c = client();
  const Bucket = config.objectstore.bucket;
  try {
    await c.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await c.send(new CreateBucketCommand({ Bucket }));
  } finally {
    c.destroy();
  }
}

async function provisionStorage(app) {
  await ensureBucket();
  return { storagePrefix: `${app.slug}/` };
}

module.exports = { provisionStorage, ensureBucket };
