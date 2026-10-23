import { defineConfig } from 'vite';

// Served under /admin/ because the admin cookies are scoped to path /admin: the SPA must be able to read the CSRF cookie.
// Dev: the SPA and the admin API share one origin through this proxy (D-029), same as the nginx setup in prod.
export default defineConfig({
  base: '/admin/',
  // UI kit and styles come from the dashboard sources; resolve React from this app so there is one copy.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { port: 5174, strictPort: true, proxy: { '/admin/v1': 'http://localhost:3000' } },
});
