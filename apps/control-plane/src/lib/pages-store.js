'use strict';

// Object-store backing for Pages file bytes. Files live in a dedicated bucket
// (config.pages.bucket) under the key "<pageId>/<name>". Metadata lives in Postgres
// (page_files); this module only moves bytes. Uses the platform object-store creds.

const {
  S3Client, HeadBucketCommand, CreateBucketCommand,
  PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const config = require('../config');

function client() {
  return new S3Client({
    endpoint: config.objectstore.endpoint,
    region: config.objectstore.region,
    credentials: { accessKeyId: config.objectstore.accessKey, secretAccessKey: config.objectstore.secretKey },
    forcePathStyle: true
  });
}

const BUCKET = config.pages.bucket;
const keyFor = (pageId, name) => `${pageId}/${name}`;

let ensured = false;
async function ensureBucket(c) {
  if (ensured) return;
  try { await c.send(new HeadBucketCommand({ Bucket: BUCKET })); }
  catch { await c.send(new CreateBucketCommand({ Bucket: BUCKET })); }
  ensured = true;
}

async function putFile(pageId, name, body, contentType) {
  const c = client();
  try {
    await ensureBucket(c);
    await c.send(new PutObjectCommand({ Bucket: BUCKET, Key: keyFor(pageId, name), Body: body, ContentType: contentType }));
  } finally { c.destroy(); }
}

// Returns { body: Buffer, contentType } or null if missing.
async function getFile(pageId, name) {
  const c = client();
  try {
    const r = await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyFor(pageId, name) }));
    const body = Buffer.from(await r.Body.transformToByteArray());
    return { body, contentType: r.ContentType };
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  } finally { c.destroy(); }
}

async function deleteFile(pageId, name) {
  const c = client();
  try { await c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: keyFor(pageId, name) })); }
  finally { c.destroy(); }
}

// Delete every object under a page's prefix (used on page delete). Best-effort.
// Move every object from one page prefix to another. Used when a page is given a
// new public id: the id is baked into the storage key, so the files have to
// follow it or the page comes back empty.
async function movePrefix(fromPageId, toPageId) {
  const c = client();
  let moved = 0;
  try {
    let token;
    do {
      const list = await c.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${fromPageId}/`, ContinuationToken: token }));
      for (const o of list.Contents || []) {
        const rest = o.Key.slice(`${fromPageId}/`.length);
        await c.send(new CopyObjectCommand({
          Bucket: BUCKET, Key: `${toPageId}/${rest}`,
          CopySource: `/${BUCKET}/${encodeURIComponent(o.Key).replace(/%2F/g, '/')}`
        }));
        moved++;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  } finally { c.destroy(); }
  // Only once every copy has succeeded — a half-moved page with its originals
  // already deleted is unrecoverable.
  await deleteAll(fromPageId);
  return moved;
}

async function deleteAll(pageId) {
  const c = client();
  try {
    let token;
    do {
      const list = await c.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${pageId}/`, ContinuationToken: token }));
      const objs = (list.Contents || []).map((o) => ({ Key: o.Key }));
      if (objs.length) await c.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objs } }));
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  } catch (err) { console.error('[pages-store] deleteAll failed:', err.message); }
  finally { c.destroy(); }
}

module.exports = { movePrefix, putFile, getFile, deleteFile, deleteAll, keyFor, BUCKET };
