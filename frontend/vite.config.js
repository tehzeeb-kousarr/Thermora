import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 5173,
      // Forward API calls to the FastAPI backend during development,
      // so the frontend can keep using relative "/api/..." paths.
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
      },
    },
    build: {
      // The two heavy libs (three.js for the landing hero, Leaflet for the
      // heat map) already lazy-load as separate chunks via React.lazy in
      // App.jsx — this just keeps them in their own named vendor chunks
      // too, instead of interleaved with app code, for better browser
      // caching across deploys.
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('three') || id.includes('@react-three')) return 'vendor-three';
              if (id.includes('leaflet')) return 'vendor-leaflet';
            }
          },
        },
      },
    },
  };
});
