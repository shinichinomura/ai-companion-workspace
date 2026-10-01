import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// 1 つのターミナル（xterm + PTY）を司るインスタンス。タブで複数並ぶため、
// 親（TerminalPane）が id ごとにマウントし、非アクティブなものは display:none で隠す
// （アンマウントせず PTY を保持する）。入出力は id 付きで main の PTY と結びつける。
export interface TerminalHandle {
  // 端末本体にフォーカスする。
  focus: () => void
  // テキストをそのまま PTY に書き込む（定型プロンプト送信などに使う）。
  sendText: (text: string) => void
  // 終了したシェルを同じ cwd で起動し直す。
  restart: () => void
}

interface TerminalInstanceProps {
  // タブ内でのターミナル識別子。main 側の PTY と 1:1 で対応する。
  id: string
  // ベル通知に出す表示名（ユーザーが付けた名前、無ければ「ターミナル N」）。
  label: string
  // このターミナルが現在表示中（アクティブ）か。false の間は display:none で隠す。
  active: boolean
  // ターミナルペイン全体が折りたたまれているか。表示復帰時にサイズを測り直す。
  collapsed: boolean
  // マウント時にハンドルを登録、アンマウント時に null で解除する。
  setHandle: (id: string, handle: TerminalHandle | null) => void
  // シェルの終了/再起動でこのターミナルの終了状態が変わったら親に通知する。
  // exited=true のとき、PTY の終了コードが分かる場合は exitCode を添える
  // （起動エラーなど PTY 由来でない終了では undefined）。親はこれでタブの自動クローズを判断する。
  onExitedChange: (id: string, exited: boolean, exitCode?: number) => void
}

function TerminalInstance({
  id,
  label,
  active,
  collapsed,
  setHandle,
  onExitedChange
}: TerminalInstanceProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // 折りたたみ/タブ切替からの復帰時にサイズを測り直すため保持する。
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  // ファイルを drag 中かどうか。ドロップ可能であることを視覚的に示す。
  const [dragOver, setDragOver] = useState(false)

  // props のコールバックは識別子が毎レンダー変わりうるため ref に逃がし、
  // 端末初期化 effect の依存を id だけに保つ（再マウントで PTY を失わないため）。
  const setHandleRef = useRef(setHandle)
  setHandleRef.current = setHandle
  const onExitedRef = useRef(onExitedChange)
  onExitedRef.current = onExitedChange
  // label は名前変更で変わりうるが、effect 依存を id だけに保つため ref 経由で参照する。
  const labelRef = useRef(label)
  labelRef.current = label

  useEffect(() => {
    if (!containerRef.current) return

    // xterm 本体と FitAddon を生成する。
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      // ペインの配色に合わせた最低限のテーマ。背景は CSS の --bg-pane(#252526) と揃える。
      theme: { background: '#252526', foreground: '#d4d4d4' }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitRef.current = fitAddon
    termRef.current = term

    // コンテナのサイズに合わせて端末サイズを確定する。
    fitAddon.fit()

    // PTY を起動する。初回起動と、終了後の再起動の両方で使う。
    let disposed = false
    const startPty = (): void => {
      if (disposed) return
      // 再起動時はコンテナサイズが変わっている可能性があるので測り直す。
      try {
        fitAddon.fit()
      } catch {
        // サイズが取れないタイミングは無視する。
      }
      onExitedRef.current(id, false)
      void window.api.terminalStart({ id, cols: term.cols, rows: term.rows }).then((res) => {
        if (disposed) return
        if (res.error) {
          term.writeln(`\x1b[31m${res.error}\x1b[0m`)
          onExitedRef.current(id, true)
        }
      })
    }
    startPty()

    // ユーザー入力 → main(PTY)。id 付きで送る。
    const inputSub = term.onData((data) => {
      window.api.terminalInput({ id, data })
    })

    // ベル（\x07）を main に通知する。claude CLI が操作待ちになると鳴らすため、
    // アプリが非アクティブ／別タブのときに main 側で OS 通知を出す。
    const bellSub = term.onBell(() => {
      window.api.notifyTerminalBell({ id, label: labelRef.current })
    })

    // PTY 出力 → xterm。自分宛て（id 一致）のみ書き込む。
    const offData = window.api.onTerminalData((msg) => {
      if (!disposed && msg.id === id) term.write(msg.data)
    })

    // プロセス終了通知。自分宛てなら終了状態を立て、再起動できるようにする。
    // exitCode を親に渡し、正常終了ならタブごと閉じるかどうかは親に委ねる。
    const offExit = window.api.onTerminalExit((exit) => {
      if (!disposed && exit.id === id) {
        term.writeln(`\r\n\x1b[90m[プロセスが終了しました (code ${exit.exitCode})]\x1b[0m`)
        onExitedRef.current(id, true, exit.exitCode)
      }
    })

    // ペインのリサイズに追従し、サイズ変更を main に伝える。
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        window.api.terminalResize({ id, cols: term.cols, rows: term.rows })
      } catch {
        // コンテナが一時的に 0 サイズの場合などは無視する。
      }
    })
    resizeObserver.observe(containerRef.current)

    // 親から呼べる操作を登録する。
    setHandleRef.current(id, {
      focus: () => term.focus(),
      sendText: (text) => window.api.terminalInput({ id, data: text }),
      restart: () => {
        // 前回の出力を消してから起動し直し、画面を綺麗にする。
        term.reset()
        startPty()
        term.focus()
      }
    })

    return () => {
      disposed = true
      resizeObserver.disconnect()
      inputSub.dispose()
      bellSub.dispose()
      offData()
      offExit()
      // main 側の PTY も破棄する（タブを閉じた・アンマウント時）。
      window.api.terminalDispose({ id })
      term.dispose()
      fitRef.current = null
      termRef.current = null
      setHandleRef.current(id, null)
    }
  }, [id])

  // 非表示（別タブ／折りたたみ）から表示に戻ったらサイズを測り直してフォーカスする。
  // 非表示中は 0 サイズなので fit がずれるため、表示確定後の rAF で測る。
  useEffect(() => {
    if (!active || collapsed) return
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
        const t = termRef.current
        if (t) {
          window.api.terminalResize({ id, cols: t.cols, rows: t.rows })
          t.focus()
        }
      } catch {
        // サイズが取れないタイミングは無視する。
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [active, collapsed, id])

  // ターミナルへドロップしたファイルパスを、シェルでそのまま使える形にエスケープする。
  // 標準ターミナルへのドロップと同じく、空白やシェル特殊文字を backslash で退避する。
  const escapePath = (p: string): string => p.replace(/([ !"#$&'()*,;<>?@[\\\]^`{|}~])/g, '\\$1')

  // ファイルがターミナル本体にドロップされたとき。
  // 各ファイルの絶対パスをエスケープして空白区切りで挿入する（改行は付けず実行はしない）。
  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const text = files
      .map((f) => escapePath(window.api.getPathForFile(f)))
      .filter((p) => p.length > 0)
      .join(' ')
    if (!text) return
    // 末尾に空白を付けて、続けて入力しやすくする（標準ターミナルの挙動に合わせる）。
    window.api.terminalInput({ id, data: text + ' ' })
    termRef.current?.focus()
  }

  // drag 中はドロップを受け付けるため preventDefault が必須。
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (!dragOver) setDragOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    // 子要素間の移動では leave が誤発火するため、コンテナ外に出たときだけ解除する。
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
  }

  return (
    <div
      ref={containerRef}
      className={`terminal-body${dragOver ? ' drag-over' : ''}`}
      style={{ display: active ? undefined : 'none' }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    />
  )
}

export default TerminalInstance
