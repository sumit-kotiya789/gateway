import { defineConfig } from 'vite';

// Dev: the SPA and the dashboard API share one origin through this proxy (D-029), same as the nginx setup in prod.
export default defineConfig({
  server: { port: 5173, strictPort: true, proxy: { '/v1/dashboard': 'http://localhost:3000' } },
});
