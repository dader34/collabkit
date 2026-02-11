import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@collabkit/client': path.resolve(__dirname, '../../../js/src'),
    },
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:8002',
        ws: true,
      },
    },
  },
});
