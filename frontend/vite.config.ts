import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 백엔드(server/index.js)는 127.0.0.1:3000 에 뜬다. /api 요청만 그쪽으로 넘긴다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
