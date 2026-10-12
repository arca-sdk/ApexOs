import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: Number(process.env.HEARTH_WEB_PORT ?? 5173),
    proxy: {
      '/api': { target: `http://localhost:${process.env.HEARTH_API_PORT ?? 8080}`, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
