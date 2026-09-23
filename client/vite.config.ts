import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base '/app/' — the SPA is served by the existing Express server under /app,
// behind the same auth middleware as the classic UI.
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: 'dist',
    // Stable, non-hashed filenames so index.html always references assets that
    // exist — immune to CDN caching index.html separately from the hashed bundle
    // (which caused 404s / MIME errors on Vercel).
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app.[ext]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Same-origin proxy to the Express server so the outreach_auth cookie flows.
      '/api': 'http://localhost:3000',
      // In DEV ONLY, Vite rewrites the absolute hrefs in index.html to sit under
      // `base` — /css/style.css becomes /app/css/style.css. Nothing serves that,
      // so it fell through to the SPA fallback and came back as index.html with
      // Content-Type text/html; Chrome's strict MIME check then refuses to apply
      // it and the app renders with only the client's own stylesheets. These two
      // entries strip the /app prefix back off before forwarding to Express.
      // The production build is unaffected: dist/index.html keeps /css/style.css.
      '/app/css': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/app/, '') },
      '/app/js':  { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/app/, '') },
      '/css': 'http://localhost:3000',
      // Serves /js/telemetry.js, which index.html loads by absolute path.
      '/js': 'http://localhost:3000',
      '/login': 'http://localhost:3000',
      '/logout': 'http://localhost:3000',
      '/sample-contacts.csv': 'http://localhost:3000',
    },
  },
});
