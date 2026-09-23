import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5180,
  },
  // pdf.js 是动态 import 的大依赖：预打包掉，避免首次选 PDF 时触发 dev server 重新优化导致页面刷新
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
  build: {
    outDir: 'dist',
  },
})