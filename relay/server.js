'use strict';

// Entry point. Listens on ASTRODOCK_PORT (set by Astrodock) or PORT.

const { loadConfig } = require('./src/config');
const { createRelay } = require('./src/app');
const { createPostgresStore } = require('./src/store/postgres');

async function main() {
  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new Error('Set RELAY_DATABASE_URL or ASTRODOCK_DATABASE_URL');
  }
  const store = createPostgresStore(config.databaseUrl);
  await store.init();

  const relay = createRelay({ config, store });
  const address = await relay.listen(config.port);
  console.log(`push relay listening on ${address.port} (registration ${config.registration}, apns ${Boolean(config.apns)}, fcm ${Boolean(config.fcm)})`);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    await relay.close().catch(() => {});
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  console.error(`push relay failed to start: ${err.message}`);
  process.exit(1);
});
