import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initIpcSync } from './state/ipcSync';
import './styles/globals.css';

// Bridge main-process tool-router events into the canonical store.
initIpcSync();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
