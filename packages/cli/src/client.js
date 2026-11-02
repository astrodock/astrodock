'use strict';

// Tiny HTTP client for the Astrodock admin API. Base URL + token come from the
// environment (ASTRODOCK_URL, ASTRODOCK_TOKEN) or from .env.astrodock in the
// app repo — see src/credentials.js — unless overridden by the caller.

const { loadCredentials, CRED_FILE } = require('./credentials');

function makeClient({ url, token } = {}) {
  if (url === undefined || token === undefined) {
    const creds = loadCredentials();
    if (url === undefined) url = creds.ASTRODOCK_URL;
    if (token === undefined) token = creds.ASTRODOCK_TOKEN;
  }
  if (!url) {
    throw new Error(
      `ASTRODOCK_URL is not set (e.g. https://admin.example.com) — export it, ` +
      `or put it in ${CRED_FILE} in the app repo root`
    );
  }
  const base = url.replace(/\/$/, '');
  // The token travels in a header, so plain http hands it to anyone on the path.
  // Loopback is the exception (a local control plane in development).
  let parsed;
  try { parsed = new URL(base); } catch { throw new Error(`ASTRODOCK_URL is not a valid URL: ${url}`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`ASTRODOCK_URL must use https (got ${parsed.protocol}//${parsed.host})`);
  }

  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      throw new Error(`Cannot reach ${base}: ${err.message}`);
    }
    let json = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
    return { status: res.status, json };
  }

  async function uploadRaw(path, buffer) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: buffer
    });
    let json = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
    return { status: res.status, json };
  }

  // multipart/form-data POST (fetch sets the boundary; don't set Content-Type).
  async function postForm(path, form) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form
      });
    } catch (err) {
      throw new Error(`Cannot reach ${base}: ${err.message}`);
    }
    let json = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
    return { status: res.status, json };
  }

  // POST JSON and read the reply as server-sent events, calling
  // onEvent(event, data) for each as it arrives. Used by `astrodock server run`.
  async function stream(path, body, onEvent) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new Error(`Cannot reach ${base}: ${err.message}`);
    }
    if (!res.ok) {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json };
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        let event = 'message';
        let data = '';
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        let parsed = data;
        try { parsed = JSON.parse(data); } catch { /* raw */ }
        onEvent(event, parsed);
      }
    }
    return { status: res.status, json: null };
  }

  return { base, hasToken: !!token, request, uploadRaw, postForm, stream };
}

module.exports = { makeClient };
