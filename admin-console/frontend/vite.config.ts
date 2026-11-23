import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The Admin Console backend (admin-console/backend, npm run dev).
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
})
