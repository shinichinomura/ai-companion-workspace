import { useEffect, useState } from 'react'
import { DEFAULT_QUICK_PROMPTS, type QuickPrompt } from '../../../shared/ipc'
import { useSettingsStore } from '../store/settings'

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
  const save = useSettingsStore((s) => s.save)

  // 編集用のローカル状態。モーダルを開くたびにストアの現在値で初期化する（キャンセルで破棄できる）。
  const [prompts, setPrompts] = useState<QuickPrompt[]>([])

  useEffect(() => {
    if (open) setPrompts(quickPrompts.map((q) => ({ ...q })))
  }, [open, quickPrompts])

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

  const handleSave = async (): Promise<void> => {
    // ラベルもプロンプトも空の行は捨てる（main 側でも同様に正規化される）。
    const cleaned = prompts.filter((p) => p.label.trim() || p.prompt.trim())
    await save({ quickPrompts: cleaned })
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
