import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

// Only the derived address goes into the page. The key itself is never handed to the bundle.
function writerAddress(mode: string): string {
  const key = process.env.ARKIV_WRITER_KEY ?? loadEnv(mode, process.cwd(), 'ARKIV_').ARKIV_WRITER_KEY
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? privateKeyToAccount(key as Hex).address : ''
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), nodePolyfills()],
  define: { __ARKIV_WRITER__: JSON.stringify(writerAddress(mode)) },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        receipts: path.resolve(__dirname, 'receipts.html'),
      },
    },
  },
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
      '@worldcoin/idkit-core',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
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
}))
