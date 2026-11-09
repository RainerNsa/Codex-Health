// The reviewer app, unchanged, on the in-browser backend: start the database and the API routes, then mount the app.
import { startBackend } from './backend.ts';

startBackend().then(() => import('../../web/src/main.tsx')).catch(() => {
  const root = document.getElementById('root');
  if (root) root.textContent = 'The preview could not start in this browser. Try a current Chrome, Edge, Firefox or Safari.';
});
