import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/space-grotesk/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/code.css';
import './styles/home.css';
import './styles/pages.css';
import './styles/docs.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
