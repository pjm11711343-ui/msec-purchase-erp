import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: { output: { manualChunks: { firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore'], xlsx: ['xlsx'] } } },
  },
});
