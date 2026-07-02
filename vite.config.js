import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build so dist/index.html runs directly from disk (file://) with no server.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { target: 'esnext' }
});
