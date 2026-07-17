import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { seedLocalProxyDefaults } from './agent/proxyDefaults'

// Seed the local-proxy agent defaults before anything reads the vault, so the
// chat works on first open with zero configuration.
seedLocalProxyDefaults()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
