import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  cacheDir: 'node_modules/.vite_cache', // 启用构建缓存
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  optimizeDeps: {
    // 不需要预构建 pdfjs-dist,因为已经移除了这个依赖
    exclude: [],
    force: false // 避免强制重新预构建
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
    reportCompressedSize: false,  // 关闭 gzip 大小报告，减少构建输出
    // 增量构建
    minify: 'esbuild', // 使用 esbuild 替代 terser，速度更快
    target: 'esnext',  // 现代浏览器，减少 polyfill
    // 依赖预构建
    commonjsOptions: {
      ignoreTryCatch: false,
      requireReturnsDefault: 'auto'
    },
    rollupOptions: {
      output: {
        // 保持 chunk 文件名稳定，利于缓存
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name.split('.')
          const ext = info[info.length - 1]
          // 保持 CSS 文件名稳定
          if (/\.css$/i.test(assetInfo.name)) {
            return 'assets/[name]-[hash][extname]'
          }
          return 'assets/[name]-[hash][extname]'
        },
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
