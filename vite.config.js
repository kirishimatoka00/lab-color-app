import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' 讓打包結果可在 Capacitor WebView（本機檔案）與任意子路徑下運作
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2500,
  },
});
