import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/admin': 'http://localhost:3100',
      '/verify': 'http://localhost:3100',
      '/webhooks': 'http://localhost:3100'
    }
  }
});
