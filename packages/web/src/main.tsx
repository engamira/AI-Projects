import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HealthResponse } from '@cl/shared';

function App() {
  const [health, setHealth] = useState<HealthResponse | 'loading' | 'unreachable'>('loading');
  useEffect(() => {
    fetch('/health')
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setHealth('unreachable'));
  }, []);
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '4rem auto', padding: '0 16px' }}>
      <h1>Campaign LEGO</h1>
      <p>Milestone M0 – hosting skeleton.</p>
      <p>
        Server status:{' '}
        <strong>{typeof health === 'string' ? health : `${health.status} (database: ${health.database})`}</strong>
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
