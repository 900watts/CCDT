import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // no-store so backend/schema changes are always picked up during dev
    headers: { 'Cache-Control': 'no-store' }
  }
})
