import { defineConfig } from 'vite';

// Public site: landing, how it works, security, pricing, guides and the API reference. Static, no API calls. Links go
// to the dashboard and the demo (VITE_DASHBOARD_URL, VITE_DEMO_URL at build time). Self-contained styles (src/styles);
// the hero's three.js scene is a dynamic import, so it lands in its own chunk loaded after first paint.
export default defineConfig({
  server: { port: 5175, strictPort: true },
  build: {
    // Never inline assets as data: URIs: the CSP allows fonts from 'self' only (security-headers.conf).
    assetsInlineLimit: 0,
    // The lazy three.js chunk is ~565 kB minified (~140 kB gzip) and only loads for the hero.
    chunkSizeWarningLimit: 600,
  },
});
