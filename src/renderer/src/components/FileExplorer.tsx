import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { DEFAULT_FONT_SIZES, type FileNode, type GitFileStatus } from '../../../shared/ipc'
import { useWorkspaceStore, selectActiveFile } from '../store/workspace'
import { useSettingsStore } from '../store/settings'
import { useTerminalBridge } from '../store/terminalBridge'

// 右クリックで開いたコンテキストメニューの状態。
interface MenuState {
  node: FileNode
  // 画面座標（position: fixed の left / top）。
  x: number
  y: number
}

// 再帰的な TreeNode へメニュー/リネームの操作を渡すための context。
interface ExplorerInteraction {
  // 行を右クリックしたときにメニューを開く。
  openMenu: (node: FileNode, x: number, y: number) => void
  // リネーム編集中の relPath（その行だけ入力欄を表示する）。
  renamingPath: string | null
  // コンテキストメニューを開いている対象の relPath（その行をハイライトする）。null = 非表示。
  menuTargetPath: string | null
  // リネームを確定する（名前が変わっていれば実行）。
  commitRename: (relPath: string, newName: string) => void
  // リネームを取りやめる。
  cancelRename: () => void
}

const ExplorerContext = createContext<ExplorerInteraction | null>(null)

function useExplorer(): ExplorerInteraction {
  const ctx = useContext(ExplorerContext)
  if (!ctx) throw new Error('ExplorerContext がありません')
  return ctx
}

// relPath の親ディレクトリ relPath（トップレベルは ''）。
function parentDir(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? '' : relPath.slice(0, idx)
}

// relPath の末尾セグメント（表示名）。
function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf('/')
  return idx === -1 ? relPath : relPath.slice(idx + 1)
}

// ディレクトリ先・名前順のソート（readDir と同じ規則）。
function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

// 実ノードに、その階層の「削除（ファントム）」ノードを合流させる。
// 削除ファイルはディスク上に無く readDir に現れないため、Git status から行を復元する。
function withDeletedPhantoms(
  dir: string,
  real: FileNode[],
  statuses: Record<string, GitFileStatus>
): FileNode[] {
  const existing = new Set(real.map((n) => n.relPath))
  const phantoms: FileNode[] = []
  for (const [p, st] of Object.entries(statuses)) {
    if (st !== 'deleted') continue
    if (parentDir(p) !== dir) continue
    // 同名ファイルが再作成され実ノードがある場合は重複させない。
    if (existing.has(p)) continue
    phantoms.push({ relPath: p, name: baseName(p), isDirectory: false })
  }
  return phantoms.length === 0 ? real : sortNodes([...real, ...phantoms])
}

// 隠しファイル表示が off のとき、. で始まる名前のノードを除外する。
function visibleNodes(nodes: FileNode[], showHidden: boolean): FileNode[] {
  return showHidden ? nodes : nodes.filter((n) => !n.name.startsWith('.'))
}

// 変更を含む祖先ディレクトリ（フォルダ名を色づけする対象）の集合を作る。
function computeChangedDirs(statuses: Record<string, GitFileStatus>): Set<string> {
  const set = new Set<string>()
  for (const p of Object.keys(statuses)) {
    let d = parentDir(p)
    // d が '' になるまで（= トップレベルに達するまで）祖先を辿って印を付ける。
    while (d !== '') {
      if (set.has(d)) break // ここから上は登録済み。
      set.add(d)
      d = parentDir(d)
    }
  }
  return set
}

// Git status のレター（追加=A / 変更=M / 削除=D）。
const STATUS_LETTER: Record<GitFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D'
}

interface TreeProps {
  node: FileNode
  depth: number
  statuses: Record<string, GitFileStatus>
  changedDirs: Set<string>
}

// リネーム時のインライン入力欄。開いた瞬間に拡張子を除いた部分を選択する（VSCode 同様）。
function RenameInput({
  initialName,
  onCommit,
  onCancel
}: {
  initialName: string
  onCommit: (newName: string) => void
  onCancel: () => void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  // Enter / blur の二重確定を防ぐためのフラグ。
  const doneRef = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // 拡張子の手前までを選択する（ドットで始まる名前は全選択）。
    const dot = initialName.lastIndexOf('.')
    if (dot > 0) {
      el.setSelectionRange(0, dot)
    } else {
      el.select()
    }
  }, [initialName])

  const commit = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    onCommit(ref.current?.value ?? initialName)
  }
  const cancel = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }

  return (
    <input
      ref={ref}
      className="tree-rename-input"
      defaultValue={initialName}
      spellCheck={false}
      // 行クリック（開く・展開）に伝播させない。
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      onBlur={commit}
    />
  )
}

// ツリーの 1 ノード。ディレクトリは展開状態に応じて子を再帰描画する。
function TreeNode({ node, depth, statuses, changedDirs }: TreeProps): JSX.Element {
  const expandedDirs = useWorkspaceStore((s) => s.expandedDirs)
  const childrenByDir = useWorkspaceStore((s) => s.childrenByDir)
  const activeFile = useWorkspaceStore(selectActiveFile)
  const showHidden = useWorkspaceStore((s) => s.showHidden)
  const toggleDir = useWorkspaceStore((s) => s.toggleDir)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const { openMenu, renamingPath, menuTargetPath, commitRename, cancelRename } = useExplorer()

  const isExpanded = node.isDirectory && expandedDirs.has(node.relPath)
  const isActive = !node.isDirectory && activeFile?.relPath === node.relPath
  const children = childrenByDir[node.relPath]

  // ファイルの Git status（ディレクトリは status を持たない）。
  const status = node.isDirectory ? undefined : statuses[node.relPath]
  // 削除（ファントム）行はディスク上に無いので開けない。
  const isDeleted = status === 'deleted'
  // 変更を含むフォルダはフォルダ名を色づけする。
  const dirChanged = node.isDirectory && changedDirs.has(node.relPath)
  // この行がリネーム編集中か。
  const isRenaming = renamingPath === node.relPath
  // この行を対象にコンテキストメニューを開いているか。
  const isMenuTarget = menuTargetPath === node.relPath

  // ラベル（ファイル名）の色クラス。
  const labelClass = status
    ? ` git-${status}`
    : dirChanged
      ? ' git-dir-changed'
      : ''

  // ⌥ を押しながらクリックすると、新しいタブで開く。
  const handleClick = (e: React.MouseEvent): void => {
    if (isDeleted) return
    if (node.isDirectory) {
      void toggleDir(node.relPath)
    } else {
      void openFile(node, { newTab: e.altKey })
    }
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    // 削除（ファントム）行はディスク上に無いので操作できない。
    if (isDeleted) return
    e.preventDefault()
    openMenu(node, e.clientX, e.clientY)
  }

  // 展開時の子: 実ノード + 削除ファントム → 隠しファイルフィルタ。
  const renderedChildren =
    isExpanded && children
      ? visibleNodes(withDeletedPhantoms(node.relPath, children, statuses), showHidden)
      : []

  return (
    <>
      <div
        className={`tree-row${isActive ? ' active' : ''}${isDeleted ? ' deleted' : ''}${isMenuTarget ? ' menu-target' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={node.name}
      >
        <span className="tree-twisty">{node.isDirectory ? (isExpanded ? '▾' : '▸') : ''}</span>
        <span className="tree-icon">{node.isDirectory ? '📁' : '📄'}</span>
        {isRenaming ? (
          <RenameInput
            initialName={node.name}
            onCommit={(newName) => commitRename(node.relPath, newName)}
            onCancel={cancelRename}
          />
        ) : (
          <span className={`tree-label${labelClass}`}>{node.name}</span>
        )}
        {status && !isRenaming && (
          <span className={`tree-git git-${status}`} aria-label={status}>
            {STATUS_LETTER[status]}
          </span>
        )}
      </div>
      {renderedChildren.map((child) => (
        <TreeNode
          key={child.relPath}
          node={child}
          depth={depth + 1}
          statuses={statuses}
          changedDirs={changedDirs}
        />
      ))}
    </>
  )
}

// 「変更ファイルのみ表示」モードで並べる 1 エントリ。
interface ChangedEntry {
  relPath: string
  // 表示名（末尾セグメント）。
  name: string
  // 所属ディレクトリの relPath（トップレベルは ''）。
  dir: string
  status: GitFileStatus
}

// gitStatuses から、変更ファイルのフラットなリストを relPath 順で組み立てる。
function buildChangedEntries(statuses: Record<string, GitFileStatus>): ChangedEntry[] {
  return Object.entries(statuses)
    .map(([relPath, status]) => ({
      relPath,
      name: baseName(relPath),
      dir: parentDir(relPath),
      status
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
}

// 「変更ファイルのみ表示」モードの 1 行。ツリーと違い階層を持たず、ファイル名 + 所属ディレクトリを並べる。
function ChangedFileRow({ entry }: { entry: ChangedEntry }): JSX.Element {
  const activeFile = useWorkspaceStore(selectActiveFile)
  const openFile = useWorkspaceStore((s) => s.openFile)
  const { openMenu, renamingPath, menuTargetPath, commitRename, cancelRename } = useExplorer()

  const { relPath, name, dir, status } = entry
  const node: FileNode = { relPath, name, isDirectory: false }
  const isActive = activeFile?.relPath === relPath
  // 削除（ファントム）行はディスク上に無いので開けない・操作できない。
  const isDeleted = status === 'deleted'
  const isRenaming = renamingPath === relPath
  const isMenuTarget = menuTargetPath === relPath

  const handleClick = (e: React.MouseEvent): void => {
    if (isDeleted) return
    void openFile(node, { newTab: e.altKey })
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    if (isDeleted) return
    e.preventDefault()
    openMenu(node, e.clientX, e.clientY)
  }

  return (
    <div
      className={`tree-row changed-row${isActive ? ' active' : ''}${isDeleted ? ' deleted' : ''}${isMenuTarget ? ' menu-target' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={relPath}
    >
      <span className="tree-icon">📄</span>
      {isRenaming ? (
        <RenameInput
          initialName={name}
          onCommit={(newName) => commitRename(relPath, newName)}
          onCancel={cancelRename}
        />
      ) : (
        <>
          <span className={`changed-name git-${status}`}>{name}</span>
          {dir && <span className="changed-dir">{dir}</span>}
        </>
      )}
      {!isRenaming && (
        <span className={`tree-git git-${status}`} aria-label={status}>
          {STATUS_LETTER[status]}
        </span>
      )}
    </div>
  )
}

// コンテキストメニューの 1 項目。
interface MenuItem {
  label: string
  onSelect: () => void
}

// 右クリックで表示するコンテキストメニュー。画面外にはみ出さないよう位置を補正する。
function ContextMenu({
  state,
  items,
  onClose
}: {
  state: MenuState
  items: MenuItem[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: state.x, y: state.y })

  // メニューサイズを測ってウィンドウ右端・下端からはみ出さないよう寄せる。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 4
    let x = state.x
    let y = state.y
    if (x + rect.width > window.innerWidth - margin) {
      x = Math.max(margin, window.innerWidth - rect.width - margin)
    }
    if (y + rect.height > window.innerHeight - margin) {
      y = Math.max(margin, window.innerHeight - rect.height - margin)
    }
    setPos({ x, y })
  }, [state.x, state.y])

  // Escape で閉じる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // 画面全体を覆う透明レイヤーで、メニュー外のクリック・右クリックを拾って閉じる。
    <div
      className="context-menu-overlay"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        ref={ref}
        className="context-menu"
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className="context-menu-item"
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// 絶対パスから表示用のフォルダ名（末尾セグメント）を取り出す。
function folderName(path: string): string {
  const segs = path.split('/').filter(Boolean)
  return segs[segs.length - 1] ?? path
}

// フォルダ未選択時に表示する、最近開いたフォルダの一覧。
function RecentFolders(): JSX.Element {
  const recentFolders = useWorkspaceStore((s) => s.recentFolders)
  const openFolderByPath = useWorkspaceStore((s) => s.openFolderByPath)

  if (recentFolders.length === 0) {
    return <div className="placeholder">フォルダが開かれていません</div>
  }
  return (
    <div className="recent-list">
      <div className="recent-title">最近開いたフォルダ</div>
      {recentFolders.map((path) => (
        <div
          key={path}
          className="recent-item"
          title={path}
          onClick={() => void openFolderByPath(path)}
        >
          <span className="recent-name">{folderName(path)}</span>
          <span className="recent-path">{path}</span>
        </div>
      ))}
    </div>
  )
}

// 「ブックマーク」セクションの折りたたみ状態を保存する localStorage キー。
// 開閉は UI の好みなので、プロジェクト（root）ごとには分けず全体で 1 つ持つ。
const BOOKMARKS_COLLAPSED_KEY = 'bookmarks-collapsed'

// ツリー上部（「最近開いたファイル」の上）に表示する「ブックマーク」の折りたたみセクション。
// ユーザーが右クリックから固定したファイルを登録順に並べる。空のときは何も表示しない。
// 行の見た目・折りたたみ挙動は「最近開いたファイル」と共通で、右クリックで解除などの操作ができる。
function Bookmarks(): JSX.Element | null {
  const bookmarks = useWorkspaceStore((s) => s.bookmarks)
  const activeFile = useWorkspaceStore(selectActiveFile)
  const openFileByRelPath = useWorkspaceStore((s) => s.openFileByRelPath)
  const { openMenu, menuTargetPath } = useExplorer()
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(BOOKMARKS_COLLAPSED_KEY) === 'true'
  )

  // 登録が無いときはセクションごと隠し、ツリーの場所を取らない。
  if (bookmarks.length === 0) return null

  const toggle = (): void => {
    setCollapsed((c) => {
      const next = !c
      localStorage.setItem(BOOKMARKS_COLLAPSED_KEY, next ? 'true' : 'false')
      return next
    })
  }

  return (
    <div className="recent-files">
      <div className="recent-files-header" onClick={toggle}>
        <span className="tree-twisty">{collapsed ? '▸' : '▾'}</span>
        <span className="recent-files-title">ブックマーク</span>
      </div>
      {!collapsed &&
        bookmarks.map((relPath) => {
          const name = baseName(relPath)
          const dir = parentDir(relPath)
          const isActive = activeFile?.relPath === relPath
          const isMenuTarget = menuTargetPath === relPath
          return (
            <div
              key={relPath}
              className={`recent-file-row${isActive ? ' active' : ''}${isMenuTarget ? ' menu-target' : ''}`}
              title={relPath}
              onClick={(e) => void openFileByRelPath(relPath, { newTab: e.altKey })}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu({ relPath, name, isDirectory: false }, e.clientX, e.clientY)
              }}
            >
              <span className="tree-icon">📌</span>
              <span className="recent-file-name">{name}</span>
              {dir && <span className="recent-file-dir">{dir}</span>}
            </div>
          )
        })}
    </div>
  )
}

// 「最近開いたファイル」セクションの折りたたみ状態を保存する localStorage キー。
// 開閉は UI の好みなので、プロジェクト（root）ごとには分けず全体で 1 つ持つ。
const RECENT_FILES_COLLAPSED_KEY = 'recent-files-collapsed'

// ツリー上部に表示する「最近開いたファイル」の折りたたみセクション。
// 現在の root 内で最近エディタに開いたファイルを新しい順に並べる。空のときは何も表示しない。
function RecentFiles(): JSX.Element | null {
  const recentFiles = useWorkspaceStore((s) => s.recentFiles)
  const activeFile = useWorkspaceStore(selectActiveFile)
  const openFileByRelPath = useWorkspaceStore((s) => s.openFileByRelPath)
  const { openMenu, menuTargetPath } = useExplorer()
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(RECENT_FILES_COLLAPSED_KEY) === 'true'
  )

  // 記録が無いときはセクションごと隠し、ツリーの場所を取らない。
  if (recentFiles.length === 0) return null

  const toggle = (): void => {
    setCollapsed((c) => {
      const next = !c
      localStorage.setItem(RECENT_FILES_COLLAPSED_KEY, next ? 'true' : 'false')
      return next
    })
  }

  return (
    <div className="recent-files">
      <div className="recent-files-header" onClick={toggle}>
        <span className="tree-twisty">{collapsed ? '▸' : '▾'}</span>
        <span className="recent-files-title">最近開いたファイル</span>
      </div>
      {!collapsed &&
        recentFiles.map((relPath) => {
          const name = baseName(relPath)
          const dir = parentDir(relPath)
          const isActive = activeFile?.relPath === relPath
          const isMenuTarget = menuTargetPath === relPath
          return (
            <div
              key={relPath}
              className={`recent-file-row${isActive ? ' active' : ''}${isMenuTarget ? ' menu-target' : ''}`}
              title={relPath}
              onClick={(e) => void openFileByRelPath(relPath, { newTab: e.altKey })}
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu({ relPath, name, isDirectory: false }, e.clientX, e.clientY)
              }}
            >
              <span className="tree-icon">📄</span>
              <span className="recent-file-name">{name}</span>
              {dir && <span className="recent-file-dir">{dir}</span>}
            </div>
          )
        })}
    </div>
  )
}

// 左ペイン: ファイルエクスプローラー。
function FileExplorer(): JSX.Element {
  const rootName = useWorkspaceStore((s) => s.rootName)
  const rootChildren = useWorkspaceStore((s) => s.childrenByDir[''])
  const showHidden = useWorkspaceStore((s) => s.showHidden)
  const setShowHidden = useWorkspaceStore((s) => s.setShowHidden)
  const showOnlyChanged = useWorkspaceStore((s) => s.showOnlyChanged)
  const setShowOnlyChanged = useWorkspaceStore((s) => s.setShowOnlyChanged)
  const gitStatuses = useWorkspaceStore((s) => s.gitStatuses)
  const renamePath = useWorkspaceStore((s) => s.renamePath)
  const bookmarks = useWorkspaceStore((s) => s.bookmarks)
  const addBookmark = useWorkspaceStore((s) => s.addBookmark)
  const removeBookmark = useWorkspaceStore((s) => s.removeBookmark)
  const openFileByRelPath = useWorkspaceStore((s) => s.openFileByRelPath)
  const watchStatus = useWorkspaceStore((s) => s.watchStatus)

  // 右クリックメニューの状態（null = 非表示）と、リネーム編集中の relPath。
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)

  const openMenu = useCallback((node: FileNode, x: number, y: number) => {
    setMenu({ node, x, y })
  }, [])

  const cancelRename = useCallback(() => setRenamingPath(null), [])

  const commitRename = useCallback(
    (relPath: string, newName: string) => {
      setRenamingPath(null)
      const trimmed = newName.trim()
      // 空・変更なしは何もしない。
      const currentName = relPath.slice(relPath.lastIndexOf('/') + 1)
      if (!trimmed || trimmed === currentName) return
      void renamePath(relPath, trimmed).catch((err) => {
        // 失敗（同名衝突・不正名など）はダイアログで知らせる。
        window.alert(err instanceof Error ? err.message : String(err))
      })
    },
    [renamePath]
  )

  const interaction = useMemo<ExplorerInteraction>(
    () => ({
      openMenu,
      renamingPath,
      menuTargetPath: menu?.node.relPath ?? null,
      commitRename,
      cancelRename
    }),
    [openMenu, renamingPath, menu, commitRename, cancelRename]
  )

  // アクティブなターミナルへ `@パス` 参照を挿入する関数（TerminalPane が登録）。
  const insertMention = useTerminalBridge((s) => s.insertMention)

  // メニューの各項目。対象ノードに対する操作を組み立てる。
  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return []
    const { relPath, isDirectory } = menu.node
    const items: MenuItem[] = [
      // ターミナルの claude へ渡すため、入力欄に `@パス` を挿入する（改行は付けない＝送信はユーザー任せ）。
      {
        label: '@ でターミナルに渡す',
        onSelect: () => insertMention?.(relPath, isDirectory)
      }
    ]
    // ファイルのみ対象。新しいタブで開く（⌥クリックでも可）。
    if (!isDirectory) {
      items.push({
        label: '新しいタブで開く',
        onSelect: () => void openFileByRelPath(relPath, { newTab: true })
      })
    }
    // ブックマークはファイルのみ対象。登録済みなら解除、未登録なら追加のトグルにする。
    if (!isDirectory) {
      items.push(
        bookmarks.includes(relPath)
          ? { label: 'ブックマークから外す', onSelect: () => void removeBookmark(relPath) }
          : { label: 'ブックマークに追加', onSelect: () => void addBookmark(relPath) }
      )
    }
    items.push(
      { label: '名称変更', onSelect: () => setRenamingPath(relPath) },
      { label: '削除', onSelect: () => void window.api.deletePath({ relPath }) },
      { label: 'Finder で表示', onSelect: () => void window.api.revealPath({ relPath }) },
      { label: 'パスをコピー', onSelect: () => void window.api.copyPath({ relPath }) }
    )
    return items
  }, [menu, insertMention, bookmarks, addBookmark, removeBookmark, openFileByRelPath])

  // 変更を含むフォルダ集合は statuses が変わったときだけ作り直す。
  const changedDirs = useMemo(() => computeChangedDirs(gitStatuses), [gitStatuses])

  // 設定画面で指定したファイルツリーのフォントサイズ（px）。
  const explorerFontSize = useSettingsStore((s) => s.fontSizes.explorer)

  // 「変更ファイルのみ表示」モード用のフラットなリスト。
  const changedEntries = useMemo(() => buildChangedEntries(gitStatuses), [gitStatuses])

  // ルート直下も削除ファントムを合流させてから描画する。
  const rootNodes = rootChildren
    ? visibleNodes(withDeletedPhantoms('', rootChildren, gitStatuses), showHidden)
    : null

  return (
    <ExplorerContext.Provider value={interaction}>
      <div className="pane-inner">
        <div className="pane-header explorer-header">
          <span className="explorer-title">{rootName ?? 'Explorer'}</span>
          {rootName && (
            <div className="explorer-actions">
              <button
                type="button"
                className={`explorer-toggle${showHidden ? ' on' : ''}`}
                onClick={() => setShowHidden(!showHidden)}
                title={showHidden ? '. で始まるファイルを隠す' : '. で始まるファイルを表示'}
                aria-pressed={showHidden}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M1 8s2.5-4.5 7-4.5 7 4.5 7 4.5-2.5 4.5-7 4.5S1 8 1 8z" />
                  <circle cx="8" cy="8" r="1.9" />
                </svg>
              </button>
              <button
                type="button"
                className={`explorer-toggle${showOnlyChanged ? ' on' : ''}`}
                onClick={() => setShowOnlyChanged(!showOnlyChanged)}
                title={showOnlyChanged ? 'すべてのファイルを表示' : '変更されたファイルのみ表示'}
                aria-pressed={showOnlyChanged}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <circle cx="4" cy="3.5" r="1.8" />
                  <circle cx="4" cy="12.5" r="1.8" />
                  <circle cx="12" cy="8" r="1.8" />
                  <path d="M4 5.3v5.4" />
                  <path d="M5.7 4.2h2.8a1.8 1.8 0 0 1 1.8 1.8v.4" />
                </svg>
              </button>
            </div>
          )}
        </div>
        {rootName && watchStatus && !watchStatus.watching && (
          // 監視対象数が上限を超えてファイル監視を停止した（fd 枯渇によるターミナル即死の防止）。
          // ツリーは自動更新されないことと、除外設定で回復できることを知らせる。
          <div className="watch-stopped-banner">
            ファイル数が多いため（{watchStatus.entryCount.toLocaleString()} 件超）、
            このフォルダの自動更新を停止しました。ターミナル・編集は通常どおり使えます。
            設定の「監視から除外するフォルダ」に生成物フォルダを追加すると再開できます。
          </div>
        )}
        {/* フォントサイズは zoom で拡縮する（行の高さ・アイコン・余白もまとめて比例する）。 */}
        <div className="pane-body tree" style={{ zoom: explorerFontSize / DEFAULT_FONT_SIZES.explorer }}>
          {rootNodes == null ? (
            <RecentFolders />
          ) : showOnlyChanged ? (
            changedEntries.length > 0 ? (
              changedEntries.map((entry) => (
                <ChangedFileRow key={entry.relPath} entry={entry} />
              ))
            ) : (
              <div className="placeholder">変更されたファイルはありません</div>
            )
          ) : (
            <>
              <Bookmarks />
              <RecentFiles />
              {rootNodes.map((node) => (
                <TreeNode
                  key={node.relPath}
                  node={node}
                  depth={0}
                  statuses={gitStatuses}
                  changedDirs={changedDirs}
                />
              ))}
            </>
          )}
        </div>
      </div>
      {menu && (
        <ContextMenu state={menu} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </ExplorerContext.Provider>
  )
}

export default FileExplorer
