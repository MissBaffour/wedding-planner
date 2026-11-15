import { defineConfig } from 'vite';

// One self-contained IIFE: <script src=".../widget.js" data-kasadesk-key="wc_..." async></script>
export default defineConfig({
  // charset ascii: host sites/CDNs often serve the script without `charset=utf-8`; escaping all
  // non-ASCII (…, ×, ₵) as \uXXXX makes the bundle immune to the page's encoding.
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact', charset: 'ascii' },
  build: {
    target: 'es2019', // older Android WebViews
    lib: { entry: 'src/main.tsx', name: 'KasaDeskWidget', formats: ['iife'], fileName: () => 'widget.js' },
    minify: 'esbuild',
    sourcemap: false,
  },
});
