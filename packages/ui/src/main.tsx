import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { seedLocalProxyDefaults } from './agent/proxyDefaults'
import { registerServiceWorker } from './registerSW'

// Seed the local-proxy agent defaults before anything reads the vault, so the
// chat works on first open with zero configuration.
seedLocalProxyDefaults()

// Install the offline service worker (production only). Issue #31.
registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
