import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // Khi dev: chạy backend ở cổng 8000 (uvicorn app.main:app --reload)
    proxy: { '/api': 'http://localhost:8000' },
  },
})
