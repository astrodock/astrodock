'use strict';

// Tiny HTTP client for the Astrodock admin API. Reads base URL + token from the
// environment (ASTRODOCK_URL, ASTRODOCK_TOKEN) unless overridden.

function makeClient({ url = process.env.ASTRODOCK_URL, token = process.env.ASTRODOCK_TOKEN } = {}) {
  if (!url) throw new Error('ASTRODOCK_URL is not set (e.g. https://admin.example.com)');
  const base = url.replace(/\/$/, '');

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

  return { base, hasToken: !!token, request, uploadRaw, postForm };
}

module.exports = { makeClient };
