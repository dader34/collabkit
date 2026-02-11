import React from 'react';
import ReactDOM from 'react-dom/client';
import { CollabkitProvider } from '@collabkit/client/react';
import { ThemeProvider } from '@dader34/stylekit-ui';
import '@dader34/stylekit-ui/styles.css';
import './styles.css';
import App from './App';

// Generate a cryptographically secure random user ID for this session
const userId = `user-${crypto.randomUUID().slice(0, 8)}`;

// Determine WebSocket URL based on current location
// Use wss:// for HTTPS pages, ws:// only for localhost development
function getWebSocketUrl(): string {
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const isHttps = window.location.protocol === 'https:';

  // In production, always use wss://
  // In development (localhost), use ws:// for convenience
  const protocol = isHttps || !isLocalhost ? 'wss:' : 'ws:';

  // Use the same host as the page, or localhost:8000 for development
  const host = isLocalhost ? 'localhost:8000' : window.location.host;

  return `${protocol}//${host}/ws`;
}

// Generate a more secure token (still demo-only, use proper auth in production)
function generateDemoToken(): string {
  // In production, this should call your authentication API
  const tokenId = crypto.randomUUID();
  return `demo-${userId}-${tokenId}`;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="brutalist">
      <CollabkitProvider
        url={getWebSocketUrl()}
        getToken={async () => generateDemoToken()}
      >
        <App userId={userId} />
      </CollabkitProvider>
    </ThemeProvider>
  </React.StrictMode>
);
