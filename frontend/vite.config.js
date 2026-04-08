import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  optimizeDeps: {
    // 不需要预构建 pdfjs-dist,因为已经移除了这个依赖
    exclude: []
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          // Vue 核心
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          // TDesign UI 库
          'tdesign': ['tdesign-vue-next'],
          // 代码高亮
          'highlight': ['highlight.js'],
          // Markdown 编辑器
          'markdown': ['marked', 'md-editor-v3']
        }
      }
    },
    chunkSizeWarningLimit: 1000
  }
})
