import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'wagmi/chains',
      'wagmi/connectors',
      'viem',
      'viem/chains',
      'connectkit',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  build: {
    // Lower peak memory on small build hosts (CI, Docker builds): no gzip size report, fewer parallel file reads.
    reportCompressedSize: false,
    rollupOptions: {
      maxParallelFileOps: 4,
      output: {
        // Split heavy, rarely-changing libraries so the app code stays small and browsers cache them separately.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('lightweight-charts')) return 'charts'
          if (id.includes('@circle-fin')) return 'circle'
          if (/node_modules[\/](wagmi|@wagmi|connectkit|@tanstack)[\/]/.test(id)) return 'wallet-ui'
          if (/node_modules[\/](viem|abitype|ox|@noble|@scure)[\/]/.test(id)) return 'viem'
          if (/node_modules[\/](react|react-dom|scheduler|framer-motion)[\/]/.test(id)) return 'react'
          return undefined
        },
      },
    },
  },
  server: {
    allowedHosts: true,
    cors: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
