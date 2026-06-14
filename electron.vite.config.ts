import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite の設定。main / preload / renderer を一括でビルドする。
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // node-pty はネイティブモジュール（.node を含む）のためバンドル不可。
        // これだけを外部化し、実行時に node_modules から require させる。
        // 他の依存（chokidar など）は従来どおりバンドルする。
        external: ['node-pty'],
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
