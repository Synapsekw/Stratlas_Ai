import '@aio/ui/fonts.css';
import '@aio/ui/tokens.css';
import '@aio/ui/mission.css';
import './styles.css';
import './package.css';
import './road/road.css';
import './report/reports.css';
import './issueCard/issueCard.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootstrap } from './bootstrap';
import { captureRendererErrors } from './diagnostics/errors';

captureRendererErrors();
bootstrap();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
