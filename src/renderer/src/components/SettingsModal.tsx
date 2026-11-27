import { useEffect, useState } from 'react'
import {
  DEFAULT_QUICK_PROMPTS,
  DEFAULT_WATCH_IGNORED_DIRS,
  DEFAULT_PANE_ARRANGEMENT,
  DEFAULT_FONT_SIZES,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  type FontSizes,
  type PaneArrangement,
  type QuickPrompt
} from '../../../shared/ipc'
import { useSettingsStore } from '../store/settings'

// フォントサイズ設定の行定義（表示順）。
const FONT_SIZE_ROWS: { key: keyof FontSizes; label: string }[] = [
  { key: 'explorer', label: 'ファイルツリー・検索' },
  { key: 'editor', label: 'エディタ' },
  { key: 'preview', label: 'プレビュー（Markdown / CSV）' },
  { key: 'terminal', label: 'ターミナル' }
]

// フォントサイズを許容範囲の整数に丸める。
function clampFontSize(v: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(v)))
}

// テキストエリアの各行を、監視除外フォルダ名の配列に整える。
// 空行・前後空白を落とし、パス区切りを含む不正な行は除外し、重複も除く（順序は保つ）。
function parseWatchDirs(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of text.split('\n')) {
    const name = raw.trim()
    if (!name || name.includes('/') || name.includes('\\') || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

interface SettingsModalProps {
  // 表示中か。
  open: boolean
  // 閉じる（キャンセル・保存後）。
  onClose: () => void
}

// 新しい空のクイック操作行を作る。id は React の key と保存後の識別に使う。
function newPrompt(): QuickPrompt {
  return { id: crypto.randomUUID(), label: '', prompt: '' }
}

// アプリ設定モーダル（spec Phase 2）。アプリメニューの「設定…」から開く。
// 設定項目はセクションとして追加していける構成にする。最初の項目はターミナルのクイック操作。
function SettingsModal({ open, onClose }: SettingsModalProps): JSX.Element | null {
  const quickPrompts = useSettingsStore((s) => s.quickPrompts)
  const watchIgnoredDirs = useSettingsStore((s) => s.watchIgnoredDirs)
  const paneArrangement = useSettingsStore((s) => s.paneArrangement)
  const fontSizes = useSettingsStore((s) => s.fontSizes)
  const save = useSettingsStore((s) => s.save)

  // 編集用のローカル状態。モーダルを開くたびにストアの現在値で初期化する（キャンセルで破棄できる）。
  const [prompts, setPrompts] = useState<QuickPrompt[]>([])
  // 監視除外フォルダは 1 行 1 フォルダ名のテキストとして編集する。
  const [watchDirsText, setWatchDirsText] = useState('')
  // ペイン配置（ファイルツリーの左右・ターミナルの前後）。
  const [arrangement, setArrangement] = useState<PaneArrangement>(DEFAULT_PANE_ARRANGEMENT)

  // ペインごとのフォントサイズ。
  const [sizes, setSizes] = useState<FontSizes>(DEFAULT_FONT_SIZES)

  useEffect(() => {
    if (open) {
      setPrompts(quickPrompts.map((q) => ({ ...q })))
      setWatchDirsText(watchIgnoredDirs.join('\n'))
      setArrangement({ ...paneArrangement })
      setSizes({ ...fontSizes })
    }
  }, [open, quickPrompts, watchIgnoredDirs, paneArrangement, fontSizes])

  // Esc で閉じる。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const updateAt = (i: number, patch: Partial<QuickPrompt>): void =>
    setPrompts((list) => list.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))

  const removeAt = (i: number): void => setPrompts((list) => list.filter((_, idx) => idx !== i))

  // 行を上下に入れ替える（ボタンの並び順を変える）。
  const move = (i: number, dir: -1 | 1): void =>
    setPrompts((list) => {
      const j = i + dir
      if (j < 0 || j >= list.length) return list
      const next = [...list]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const add = (): void => setPrompts((list) => [...list, newPrompt()])

  const resetDefaults = (): void => setPrompts(DEFAULT_QUICK_PROMPTS.map((q) => ({ ...q })))

  // 監視除外フォルダを初期値に戻す。
  const resetWatchDirs = (): void => setWatchDirsText(DEFAULT_WATCH_IGNORED_DIRS.join('\n'))

  const handleSave = async (): Promise<void> => {
    // ラベルもプロンプトも空の行は捨てる（main 側でも同様に正規化される）。
    const cleaned = prompts.filter((p) => p.label.trim() || p.prompt.trim())
    await save({
      quickPrompts: cleaned,
      watchIgnoredDirs: parseWatchDirs(watchDirsText),
      paneArrangement: arrangement,
      fontSizes: sizes
    })
    onClose()
  }

  return (
    // オーバーレイのクリックで閉じる。パネル内クリックは止める。
    <div className="settings-overlay" onMouseDown={onClose}>
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="設定"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-header">
          <span>設定</span>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="閉じる"
            title="閉じる"
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <section className="settings-section">
            <h3 className="settings-section-title">ペインの配置</h3>
            <p className="settings-section-desc">
              ファイルツリーは左端に固定です。エディタに対するターミナルの位置を選びます。保存すると操作中のタブにすぐ
              反映されます（他のタブはアプリの再起動後に反映）。エディタとターミナルを左右に並べるか
              上下に並べるかは、メニューの「表示」で切り替えます。
            </p>
            <div className="pane-arrangement-preview" aria-hidden="true">
              <div className="pane-preview-row">
                <div className="pane-preview-cell pane-preview-explorer">ファイルツリー</div>
                <div className={`pane-preview-work${arrangement.terminalFirst ? ' reversed' : ''}`}>
                  <div className="pane-preview-cell">エディタ</div>
                  <div className="pane-preview-cell">ターミナル</div>
                </div>
              </div>
            </div>
            <div className="pane-arrangement-options">
              <label>
                ターミナルの位置：
                <select
                  value={arrangement.terminalFirst ? 'first' : 'last'}
                  onChange={(e) =>
                    setArrangement((a) => ({ ...a, terminalFirst: e.target.value === 'first' }))
                  }
                >
                  <option value="last">エディタの後ろ（右 / 下）</option>
                  <option value="first">エディタの前（左 / 上）</option>
                </select>
              </label>
              <button type="button" onClick={() => setArrangement({ ...DEFAULT_PANE_ARRANGEMENT })}>
                デフォルトに戻す
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">フォントサイズ</h3>
            <p className="settings-section-desc">
              ペインごとに文字の大きさ（px）を指定します（{FONT_SIZE_MIN}〜{FONT_SIZE_MAX}）。
              保存すると操作中のタブにすぐ反映されます（他のタブはアプリの再起動後に反映）。
            </p>
            <div className="font-size-list">
              {FONT_SIZE_ROWS.map(({ key, label }) => (
                <label key={key} className="font-size-row">
                  <span className="font-size-label">{label}</span>
                  <input
                    type="number"
                    className="font-size-input"
                    min={FONT_SIZE_MIN}
                    max={FONT_SIZE_MAX}
                    step={1}
                    value={sizes[key]}
                    onChange={(e) => {
                      const v = e.target.valueAsNumber
                      if (Number.isFinite(v)) setSizes((s) => ({ ...s, [key]: v }))
                    }}
                    onBlur={() => setSizes((s) => ({ ...s, [key]: clampFontSize(s[key]) }))}
                  />
                  <span className="font-size-unit">px</span>
                </label>
              ))}
            </div>
            <div className="quick-prompt-toolbar">
              <button type="button" onClick={() => setSizes({ ...DEFAULT_FONT_SIZES })}>
                デフォルトに戻す
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">ターミナルのクイック操作</h3>
            <p className="settings-section-desc">
              ターミナルヘッダのボタンと、押したときに Claude へ送るメッセージを設定します。
              上から順にボタンが並びます。
            </p>

            <div className="quick-prompt-list">
              {prompts.length === 0 ? (
                <p className="quick-prompt-empty">
                  ボタンはありません。「追加」で作成してください。
                </p>
              ) : (
                prompts.map((p, i) => (
                  <div key={p.id} className="quick-prompt-row">
                    <div className="quick-prompt-fields">
                      <input
                        className="quick-prompt-label"
                        value={p.label}
                        placeholder="ボタン名"
                        onChange={(e) => updateAt(i, { label: e.target.value })}
                      />
                      <textarea
                        className="quick-prompt-text"
                        value={p.prompt}
                        placeholder="送信するメッセージ"
                        rows={2}
                        onChange={(e) => updateAt(i, { prompt: e.target.value })}
                      />
                    </div>
                    <div className="quick-prompt-actions">
                      <button
                        type="button"
                        title="上へ"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        title="下へ"
                        disabled={i === prompts.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </button>
                      <button type="button" title="削除" onClick={() => removeAt(i)}>
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="quick-prompt-toolbar">
              <button type="button" onClick={add}>
                ＋ 追加
              </button>
              <button type="button" onClick={resetDefaults}>
                デフォルトに戻す
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h3 className="settings-section-title">監視から除外するフォルダ</h3>
            <p className="settings-section-desc">
              ここに挙げたフォルダ名は、ファイル変更の監視対象から外します（フォルダ名の完全一致。
              1 行に 1 つ）。ファイルツリーには通常どおり表示され、監視だけを止めます。
            </p>
            <p className="settings-section-desc settings-section-note">
              目的はファイルディスクリプタ（fd）の枯渇対策です。macOS のファイル監視は監視対象の
              ファイル 1 つにつき fd を 1 つ消費するため、<code>.venv</code> のように大量のファイルを
              含むフォルダ（Python の仮想環境、各種キャッシュ、ビルド生成物など）を監視すると fd を
              使い切り、新しいターミナルが起動できず即終了（
              <code>[プロセスが終了しました (code 0)]</code>）することがあります。編集対象でない生成物を
              ここで除外してください。
            </p>
            <textarea
              className="watch-ignore-text"
              value={watchDirsText}
              spellCheck={false}
              rows={10}
              placeholder={'.venv\nnode_modules\n__pycache__'}
              onChange={(e) => setWatchDirsText(e.target.value)}
            />
            <div className="quick-prompt-toolbar">
              <button type="button" onClick={resetWatchDirs}>
                デフォルトに戻す
              </button>
            </div>
          </section>
        </div>

        <div className="settings-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn-primary" onClick={() => void handleSave()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

export default SettingsModal
