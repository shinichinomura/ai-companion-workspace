import { resolve } from 'path'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// バージョン・git ハッシュ・ビルド日時を「ビルド時」に固定して埋め込む。
// 試用版（/Applications にコピーした .app）には .git が無く、起動後に git を実行しても
// 正しいコミットを特定できないため、ビルドする瞬間の値をここで確定させる。
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string
}

// 現在の HEAD の短縮ハッシュ。リポジトリ外や git 不在では 'unknown' とする。
function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()
  } catch {
    return 'unknown'
  }
}

// main / renderer の両方へ define で注入する。値は文字列リテラルとして置換される。
// 型は src/shared/build-info.d.ts で宣言し、src/shared/build-info.ts から参照する。
const buildDefine = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __APP_GIT_HASH__: JSON.stringify(gitShortHash()),
  __APP_BUILD_DATE__: JSON.stringify(new Date().toISOString())
}

// electron-vite の設定。main / preload / renderer を一括でビルドする。
export default defineConfig({
  main: {
    define: buildDefine,
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
    define: buildDefine,
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        // index: 各タブの本体（3 ペイン）。shell: タブバー（クロームシェル）。
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          shell: resolve(__dirname, 'src/renderer/shell.html')
        }
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
