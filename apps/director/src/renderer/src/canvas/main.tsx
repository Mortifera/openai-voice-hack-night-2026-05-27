import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/globals.css';
import './canvas.css';
import { CanvasApp } from './CanvasApp';

const root = document.getElementById('canvas-root');
if (!root) throw new Error('canvas-root missing');

createRoot(root).render(
  <StrictMode>
    <CanvasApp />
  </StrictMode>,
);
