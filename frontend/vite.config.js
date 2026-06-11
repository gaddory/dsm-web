import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 개발 중엔 /api, /media, /renders 를 FastAPI(8011)로 프록시.
// 빌드 결과(dist)는 FastAPI가 직접 서빙 → 배포는 단일 URL.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8011',
      '/media': 'http://localhost:8011',
      '/renders': 'http://localhost:8011',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
