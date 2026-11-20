import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Hasil build = satu file dist/index.html (semua JS/CSS/app ter-inline).
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: 'es2022' },
});
