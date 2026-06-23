import React from 'react'
import ReactDOM from 'react-dom/client'
import Shell from './Shell'
import './shell.css'

// クロームシェル（タブバー）のエントリ。各タブ本体（App）とは別の renderer。
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>
)
