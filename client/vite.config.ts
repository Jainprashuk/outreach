import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base '/app/' — the SPA is served by the existing Express server under /app,
// behind the same auth middleware as the classic UI.
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: { outDir: 'dist' },
  server: {
    port: 5173,
    proxy: {
      // Same-origin proxy to the Express server so the outreach_auth cookie flows.
      '/api': 'http://localhost:3000',
      '/css': 'http://localhost:3000',
      '/login': 'http://localhost:3000',
      '/logout': 'http://localhost:3000',
      '/sample-contacts.csv': 'http://localhost:3000',
    },
  },
});
