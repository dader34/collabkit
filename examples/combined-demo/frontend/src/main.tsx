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
function getWebSocketUrl(): string {
  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const isHttps = window.location.protocol === 'https:';
  const protocol = isHttps || !isLocalhost ? 'wss:' : 'ws:';
  const host = isLocalhost ? 'localhost:8010' : window.location.host;
  return `${protocol}//${host}/ws`;
}

// Generate a demo token
function generateDemoToken(): string {
  const tokenId = crypto.randomUUID();
  return `demo-${userId}-${tokenId}`;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider defaultTheme="brutalist">
    <CollabkitProvider
      url={getWebSocketUrl()}
      getToken={async () => generateDemoToken()}
    >
      <App userId={userId} />
    </CollabkitProvider>
  </ThemeProvider>
);
