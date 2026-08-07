import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './app/router.tsx';
import { installTestDriver } from './test-driver.ts';
import './styles.css';

installTestDriver();

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);
