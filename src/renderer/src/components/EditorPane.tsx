import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore, isDirty } from '../store/workspace'
import { useBacklogStore } from '../store/backlog'
import MonacoEditor from './MonacoEditor'
import MarkdownPreview from './MarkdownPreview'
import CsvPreview from './CsvPreview'
import BacklogView from './BacklogView'
import TocRail from './TocRail'
import { usePreviewToc, useEditorToc } from './useToc'
import { scrollKey, useScrollMemory } from './scrollMemory'
import type { monaco } from './monacoSetup'

// Markdown として扱う拡張子か判定する。
function isMarkdown(relPath: string): boolean {
  const lower = relPath.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

// CSV / TSV として扱う拡張子か判定する。
function isCsv(relPath: string): boolean {
  const lower = relPath.toLowerCase()
  return lower.endsWith('.csv') || lower.endsWith('.tsv')
}

// Markdown プレビューの目次表示状態を保存する localStorage キー。
// 表示/非表示は UI の好みなので、プロジェクト（root）ごとには分けず全体で 1 つ持つ。
const TOC_OPEN_KEY = 'md-toc-open'

// 中央ペイン: エディタ / ビューワー。Monaco Editor でテキスト編集と保存を行う。
// 1 つのエディタタブの中身（1 ファイル分）で、Edit / Preview などの表示モードや目次の状態は
// タブごとに独立して持つ。タブの切り替えは EditorArea が行い、非アクティブなタブも
// マウントしたまま隠す（スクロール位置・カーソル・undo・表示モードを保つ）。
function EditorPane({ tabId, onClose }: { tabId: string; onClose: () => void }): JSX.Element {
  const tab = useWorkspaceStore((s) => s.tabs.find((t) => t.id === tabId))
  const activeFile = useWorkspaceStore((s) => (tab?.relPath ? (s.files[tab.relPath] ?? null) : null))
  const pendingReveal = useWorkspaceStore((s) => s.pendingReveal)
  const updateContent = useWorkspaceStore((s) => s.updateContent)
  const saveFile = useWorkspaceStore((s) => s.saveFile)
  const reloadFromDisk = useWorkspaceStore((s) => s.reloadFromDisk)
  const dismissExternalChange = useWorkspaceStore((s) => s.dismissExternalChange)
  const goBack = useWorkspaceStore((s) => s.goBack)
  const goForward = useWorkspaceStore((s) => s.goForward)

  // 戻る/進むが可能か（履歴の端では不可）。履歴はタブごと。
  const canBack = (tab?.historyIndex ?? -1) > 0
  const canForward = (tab?.historyIndex ?? -1) < (tab?.history.length ?? 0) - 1

  const dirty = isDirty(activeFile)
  const markdown = activeFile != null && !activeFile.isBinary && isMarkdown(activeFile.relPath)
  const csv = activeFile != null && !activeFile.isBinary && isCsv(activeFile.relPath)
  // Edit / Preview トグルを出せるファイル（Markdown または CSV/TSV）。
  const previewable = markdown || csv

  // 開いているファイルがバックログ索引（.noetelier/backlogs.json で宣言）なら、その定義。
  const backlogs = useBacklogStore((s) => s.backlogs)
  const backlogDef = useMemo(
    () =>
      markdown && activeFile
        ? (backlogs.find(
            (b) => b.activeIndex === activeFile.relPath || b.completedIndex === activeFile.relPath
          ) ?? null)
        : null,
    [markdown, activeFile, backlogs]
  )

  // Edit / Preview / バックログの表示状態。ストアに持たせずペイン内で管理する。
  const [view, setView] = useState<'edit' | 'preview' | 'backlog'>('edit')

  // Markdown はファイルを開くたびに Preview を既定モードにする（読む用途が主のため）。
  // 'backlog' のときは維持する（索引に「戻る」で復帰したときバックログモードを再現するため）。
  // 検索結果からのジャンプ時は後段の effect が Edit に切り替えるので、そちらが優先される。
  const relPath = activeFile?.relPath ?? null
  useEffect(() => {
    if (markdown) setView((v) => (v === 'backlog' ? v : 'preview'))
  }, [relPath, markdown])

  // 索引でないファイルでは 'backlog' を既定モード（Markdown は Preview、それ以外は Edit）として
  // 表示する。state はリセットしないので、バックログから詳細ファイルを開いて「戻る」で索引に
  // 復帰したときにバックログモードが再現される。
  const effectiveView: 'edit' | 'preview' | 'backlog' =
    view === 'backlog' && backlogDef == null ? (markdown ? 'preview' : 'edit') : view
  const backlogMode = effectiveView === 'backlog'

  // 目次（TOC）の情報源はモードで異なる。Preview は描画済み DOM（.pane-body 内）、
  // Edit は Monaco のソース行番号を使う。どちらも同じ TocRail で右上にフローティング表示する。
  const paneBodyRef = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null)
  const previewMode = markdown && effectiveView === 'preview'
  const editMode = markdown && effectiveView === 'edit'
  const content = activeFile?.content ?? ''
  const previewToc = usePreviewToc(paneBodyRef, content, previewMode)
  const editorToc = useEditorToc(editor, content, editMode)
  const toc = previewMode ? previewToc : editorToc

  // .pane-body 自身がスクロールする表示（Markdown/CSV プレビュー・バックログ）では、
  // ファイルごとのスクロール位置を覚えて復元する（記憶がなければ先頭）。
  // Monaco は内部でスクロールするため MonacoEditor 側で同様に扱う。
  const bodyScrolls =
    activeFile != null &&
    !activeFile.isBinary &&
    ((backlogMode && backlogDef != null) ||
      (markdown && effectiveView === 'preview') ||
      (csv && effectiveView === 'preview'))
  useScrollMemory(
    paneBodyRef,
    bodyScrolls && activeFile ? scrollKey(activeFile.relPath, effectiveView) : null
  )

  // このタブに対するジャンプ指示（検索結果クリック等）。対象が今このタブで開いているファイルのときだけ有効。
  const activeReveal =
    pendingReveal &&
    activeFile &&
    pendingReveal.tabId === tabId &&
    pendingReveal.relPath === activeFile.relPath
      ? pendingReveal
      : null

  // プレビュー可能なファイル（Markdown/CSV）へジャンプ指示が来たら、行が見えるよう Edit に切り替える
  // （Preview 表示のままだと Monaco が無く、スクロール・選択できないため）。
  useEffect(() => {
    if (activeReveal && previewable) setView('edit')
  }, [activeReveal, previewable])

  // Markdown プレビューの目次レールの表示状態（既定は表示）。localStorage に保存する。
  const [tocOpen, setTocOpen] = useState(() => localStorage.getItem(TOC_OPEN_KEY) !== 'false')
  const toggleToc = (): void => {
    setTocOpen((v) => {
      const next = !v
      localStorage.setItem(TOC_OPEN_KEY, next ? 'true' : 'false')
      return next
    })
  }

  return (
    <div className="pane-inner">
      <div className="pane-header">
        <span className="history-nav">
          <button
            className="history-nav-btn"
            onClick={() => void goBack(tabId)}
            disabled={!canBack}
            title="戻る"
            aria-label="戻る"
          >
            ‹
          </button>
          <button
            className="history-nav-btn"
            onClick={() => void goForward(tabId)}
            disabled={!canForward}
            title="進む"
            aria-label="進む"
          >
            ›
          </button>
        </span>
        {activeFile ? (
          <>
            {/* 狭いペインではファイル名を省略表示にして、右側のボタン類を押し出さない。 */}
            <span className="pane-title" title={activeFile.relPath}>
              <span className="pane-title-name">{activeFile.name}</span>
              {dirty && <span className="dirty-indicator" title="未保存の変更があります"> ●</span>}
            </span>
            {previewable && (
              <span className="view-toggle">
                <button
                  className={`view-toggle-btn${effectiveView === 'edit' ? ' active' : ''}`}
                  onClick={() => setView('edit')}
                >
                  Edit
                </button>
                <button
                  className={`view-toggle-btn${effectiveView === 'preview' ? ' active' : ''}`}
                  onClick={() => setView('preview')}
                >
                  Preview
                </button>
                {backlogDef && (
                  <button
                    className={`view-toggle-btn${effectiveView === 'backlog' ? ' active' : ''}`}
                    onClick={() => setView('backlog')}
                  >
                    バックログ
                  </button>
                )}
              </span>
            )}
            {markdown && !backlogMode && (
              <button
                className={`toc-toggle-btn${tocOpen ? ' active' : ''}`}
                onClick={toggleToc}
                title={tocOpen ? '目次を隠す' : '目次を表示'}
                aria-label="目次"
                aria-pressed={tocOpen}
              >
                ☰ 目次
              </button>
            )}
          </>
        ) : (
          'Editor'
        )}
        {/* ペインを隠す。ファイルツリーからファイルを開くと再表示される（⌥⌘E でも切り替え可）。 */}
        <button
          className="pane-close-btn"
          onClick={onClose}
          title="エディタを閉じる（ファイルを開くと再表示）"
          aria-label="エディタを閉じる"
        >
          ✕
        </button>
      </div>
      {activeFile?.externallyChanged && (
        <div className="conflict-banner">
          <span className="conflict-msg">
            このファイルは外部で変更されました。未保存の編集があります。
          </span>
          <button className="btn" onClick={() => void reloadFromDisk(activeFile.relPath)}>
            外部変更を読み込む（編集を破棄）
          </button>
          <button className="btn" onClick={() => dismissExternalChange(activeFile.relPath)}>
            自分の変更を保持
          </button>
        </div>
      )}
      {activeFile?.externallyDeleted && (
        <div className="conflict-banner">
          <span className="conflict-msg">
            このファイルは外部で削除されました。保存すると再作成されます。
          </span>
          <button className="btn" onClick={() => dismissExternalChange(activeFile.relPath)}>
            通知を閉じる
          </button>
        </div>
      )}
      <div
        ref={paneBodyRef}
        className={`pane-body${(previewable && effectiveView === 'preview') || backlogMode ? '' : ' editor-body'}`}
      >
        {!activeFile ? (
          <div className="placeholder">ファイルが選択されていません</div>
        ) : activeFile.isBinary ? (
          <div className="placeholder">バイナリまたは巨大なファイルのため表示できません</div>
        ) : backlogMode && backlogDef ? (
          // バックログ索引の統合ビュー。編集中の最新内容（content）を解析して表示する。
          <BacklogView
            def={backlogDef}
            openRelPath={activeFile.relPath}
            tabId={tabId}
            content={activeFile.content}
            // 索引ファイルを切り替えたら（アクティブ⇄完了など）フィルタ等の内部状態をリセットする。
            key={activeFile.relPath}
          />
        ) : markdown && effectiveView === 'preview' ? (
          // 編集中の最新内容（content）をプレビューする。
          <MarkdownPreview content={activeFile.content} relPath={activeFile.relPath} />
        ) : csv && effectiveView === 'preview' ? (
          // 編集中の最新内容（content）をテーブルとしてプレビューする。
          <CsvPreview content={activeFile.content} relPath={activeFile.relPath} />
        ) : (
          <MonacoEditor
            path={activeFile.relPath}
            value={activeFile.content}
            onChange={(value) => updateContent(activeFile.relPath, value)}
            onSave={() => void saveFile(activeFile.relPath)}
            onEditorReady={setEditor}
            reveal={
              activeReveal
                ? {
                    line: activeReveal.line,
                    column: activeReveal.column,
                    length: activeReveal.length,
                    seq: activeReveal.seq
                  }
                : undefined
            }
          />
        )}
      </div>
      {/* 目次はペイン全体の右上にフローティング表示する（.pane-body の外＝スクロール非追従）。 */}
      {markdown && !backlogMode && tocOpen && toc.headings.length > 0 && (
        <div className="toc-float">
          <TocRail headings={toc.headings} activeKey={toc.activeKey} onJump={toc.jump} />
        </div>
      )}
    </div>
  )
}

export default EditorPane
