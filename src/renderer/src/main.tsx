import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
import ExportWorker from './export/ExportWorker'

const mode = new URLSearchParams(location.search).get('mode')
const root = createRoot(document.getElementById('root')!)
root.render(<React.StrictMode>{mode === 'export' ? <ExportWorker /> : <App />}</React.StrictMode>)
