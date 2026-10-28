import React from 'react';
import { createRoot } from 'react-dom/client';
import { ShareApp } from './share-view.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ShareApp />
  </React.StrictMode>,
);
