import { defineConfig } from 'vite';

// Public site: landing, pricing and developer docs. Static, no API calls. Links go to the dashboard and the demo
// (VITE_DASHBOARD_URL, VITE_DEMO_URL at build time).
export default defineConfig({
  // UI tokens come from the dashboard styles; resolve React from this app so there is one copy.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { port: 5175, strictPort: true },
});
