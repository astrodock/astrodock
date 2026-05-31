import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds to app/dist, which the platform syncs to the static volume and Caddy
// serves at https://<subdomain>.<base-domain>. /api/* is proxied to the server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // local dev: proxy /api to the Express server (set to your TOOLSTEAD_PORT locally)
    proxy: { '/api': 'http://localhost:3000' }
  }
});
