import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { AcceptInvitePage, EnrollPage, LoginPage, VerifyPage } from './pages/auth';
import { AccountPage, ActivityPage, HomePage, Shell, UsersPage } from './pages/app';
import './styles.css';

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
      <Route element={<Shell />}>
        <Route path="/" element={<HomePage />} />
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
