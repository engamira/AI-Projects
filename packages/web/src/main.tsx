import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { AcceptInvitePage, EnrollPage, LoginPage, VerifyPage } from './pages/auth';
import { AccountPage, ActivityPage, Shell, UsersPage, WideShell } from './pages/app';
import { CampaignsPage } from './pages/campaigns';
import { EditorPage } from './editor/EditorPage';
import './styles.css';

// Color scheme: "?theme=name" previews a scheme and remembers it in this browser (a per-viewer convenience only).
const THEMES = ['ocean', 'midnight-gold', 'soft-teal', 'coral-night'];
function applyTheme() {
  let name: string | null = new URLSearchParams(location.search).get('theme');
  try {
    if (name && THEMES.includes(name)) localStorage.setItem('theme', name);
    else name = localStorage.getItem('theme');
  } catch {
    /* storage unavailable: ignore */
  }
  if (name && THEMES.includes(name)) document.documentElement.dataset.theme = name;
}
applyTheme();

function Gate() {
  const { me, can } = useSession();
  if (!me) return <div className="center-wrap"><p>Loading…</p></div>;

  if (me.stage === 'none') {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  // Password accepted but second factor not finished yet
  if (me.stage === 'password') return me.next === 'enroll_2fa' ? <EnrollPage /> : <VerifyPage />;

  return (
    <Routes>
      <Route element={<WideShell />}>
        <Route path="/campaigns/:id" element={<EditorPage />} />
      </Route>
      <Route element={<Shell />}>
        <Route path="/" element={<CampaignsPage />} />
        <Route path="/account" element={<AccountPage />} />
        {can('users.manage') && <Route path="/admin/users" element={<UsersPage />} />}
        {can('activity.view') && <Route path="/admin/activity" element={<ActivityPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
