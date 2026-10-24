import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { AcceptInvitePage, EnrollPage, LoginPage, VerifyPage } from './pages/auth';
import { AccountPage, ActivityPage, Shell, UsersPage, WideShell } from './pages/app';
import { CampaignsPage } from './pages/campaigns';
import { AudiencePage } from './pages/audience';
import { AssetsPage, BrandPage } from './pages/brand';
import { EditorPage } from './editor/EditorPage';
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
      <Route element={<WideShell />}>
        <Route path="/campaigns/:id" element={<EditorPage />} />
      </Route>
      <Route element={<Shell />}>
        <Route path="/" element={<CampaignsPage />} />
        <Route path="/account" element={<AccountPage />} />
        {can('assets.manage') && <Route path="/assets" element={<AssetsPage />} />}
        {can('audience.manage') && <Route path="/audience" element={<AudiencePage />} />}
        {can('brand.manage') && <Route path="/admin/brand" element={<BrandPage />} />}
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
