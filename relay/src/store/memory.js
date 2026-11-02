'use strict';

// In-memory store with the same contract as the Postgres one. For tests.

function createMemoryStore() {
  const servers = new Map();
  const subscriptions = new Map();

  return {
    async init() {},
    async close() {},

    async createServer({ id, name, url, secretHash }) {
      servers.set(id, { id, name, url, secretHash, createdAt: new Date() });
    },

    async getServer(id) {
      return servers.get(id) || null;
    },

    async getServerBySecretHash(secretHash) {
      for (const s of servers.values()) if (s.secretHash === secretHash) return s;
      return null;
    },

    // Returns the existing handle for (serverId, token), updating its platform
    // and environment, or stores the new one.
    async upsertSubscription({ handle, serverId, platform, environment, token }) {
      for (const sub of subscriptions.values()) {
        if (sub.serverId === serverId && sub.token === token) {
          sub.platform = platform;
          sub.environment = environment;
          sub.updatedAt = new Date();
          return sub.handle;
        }
      }
      const now = new Date();
      subscriptions.set(handle, { handle, serverId, platform, environment, token, createdAt: now, updatedAt: now });
      return handle;
    },

    async getSubscription(handle) {
      return subscriptions.get(handle) || null;
    },

    async deleteSubscription(handle) {
      return subscriptions.delete(handle);
    }
  };
}

module.exports = { createMemoryStore };
