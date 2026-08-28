import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

const PDFJS_RUNTIME_DIRECTORIES = Object.freeze(['cmaps', 'standard_fonts', 'wasm', 'iccs'])
const PDFJS_RUNTIME_ROOT = resolve(__dirname, 'node_modules/pdfjs-dist')

function pdfjsRuntimeAssets() {
  return [
    {
      name: 'pdfjs-runtime-assets-build',
      apply: 'build',
      buildStart() {
        for (const directory of PDFJS_RUNTIME_DIRECTORIES) {
          const sourceDirectory = resolve(PDFJS_RUNTIME_ROOT, directory)
          for (const fileName of readdirSync(sourceDirectory)) {
            this.emitFile({
              type: 'asset',
              fileName: `pdfjs/${directory}/${fileName}`,
              source: readFileSync(resolve(sourceDirectory, fileName))
            })
          }
        }
      }
    },
    {
      name: 'pdfjs-runtime-assets-serve',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url, 'http://localhost').pathname
          const match = /^\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/([A-Za-z0-9_.-]+)$/u.exec(pathname)
          if (!match) return next()
          const [, directory, fileName] = match
          const sourceDirectory = resolve(PDFJS_RUNTIME_ROOT, directory)
          const filePath = resolve(sourceDirectory, fileName)
          if (basename(filePath) !== fileName || !existsSync(filePath)) return next()
          const extension = extname(fileName)
          response.setHeader('Content-Type', extension === '.wasm' ? 'application/wasm' : 'application/octet-stream')
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          response.end(readFileSync(filePath))
        })
      }
    }
  ]
}

export default defineConfig({
  plugins: [vue(), ...pdfjsRuntimeAssets()],
  cacheDir: 'node_modules/.vite_cache', // 启用构建缓存
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  optimizeDeps: {
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
          'vue-vendor': ['vue', 'vue-router', 'pinia']
        }
      }
    },
    chunkSizeWarningLimit: 1000
  }
})
