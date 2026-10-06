import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.AGENTS_API || 'http://localhost:7878';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  // Frontend tests (ISL_Frontend §12): jsdom + Testing Library, so a change that breaks a
  // component fails CI instead of the operator's screen.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
});
