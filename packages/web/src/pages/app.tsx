import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  ROLES,
  ROLE_LABELS,
  type ActivityDto,
  type CreateUserRequest,
  type InviteResponse,
  type NotificationsResponse,
  type Role,
  type UserDto,
} from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';

// ---------- Shell with navigation and notification bell ----------
function Bell() {
  const [data, setData] = useState<NotificationsResponse>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<NotificationsResponse>('GET', '/api/notifications'));
    } catch {
      /* signed out or offline: ignore */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  async function markAll() {
    await api('POST', '/api/notifications/read-all');
    await load();
  }

  return (
    <div className="bell" ref={ref}>
      <button aria-label={`Notifications, ${data.unread} unread`} aria-expanded={open} onClick={() => { setOpen(!open); void load(); }}>
        🔔{data.unread > 0 && <span className="count">{data.unread}</span>}
      </button>
      {open && (
        <div className="panel" role="dialog" aria-label="Notifications">
          <div className="row" style={{ justifyContent: 'space-between', padding: '4px 8px' }}>
            <strong>Notifications</strong>
            <button className="link" disabled={data.unread === 0} onClick={() => void markAll()}>Mark all read</button>
          </div>
          {data.items.length === 0 && <p className="muted" style={{ padding: 8 }}>Nothing yet.</p>}
          {data.items.map((n) => (
            <div key={n.id} className={`item ${n.readAt ? '' : 'unread'}`}>
              <div>{n.title}</div>
              {n.body && <div className="muted" style={{ fontWeight: 400 }}>{n.body}</div>}
              <div className="muted" style={{ fontWeight: 400, fontSize: '0.8rem' }}>{new Date(n.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Topbar() {
  const { me, can, signOut } = useSession();
  return (
      <header className="topbar">
        <span className="brand">Campaign LEGO</span>
        <nav aria-label="Main">
          <NavLink to="/" end>Campaigns</NavLink>
          {can('users.manage') && <NavLink to="/admin/users">Users</NavLink>}
          {can('activity.view') && <NavLink to="/admin/activity">Activity</NavLink>}
          <NavLink to="/account">Account</NavLink>
        </nav>
        <span className="muted">{me?.user?.name} · {me?.user ? ROLE_LABELS[me.user.role] : ''}</span>
        <Bell />
        <button onClick={() => void signOut()}>Sign out</button>
      </header>
  );
}

export function Shell() {
  return (
    <>
      <Topbar />
      <main className="page"><Outlet /></main>
    </>
  );
}

/** Full-width layout for the email editor. */
export function WideShell() {
  return (
    <div className="wide-shell">
      <Topbar />
      <Outlet />
    </div>
  );
}

// ---------- Home ----------
export function HomePage() {
  const { me } = useSession();
  const u = me!.user!;
  return (
    <>
      <h1>Welcome, {u.name}</h1>
      <p className="muted">You are signed in as <strong>{ROLE_LABELS[u.role]}</strong>.</p>
      <div className="card wide">
        <h2 style={{ marginTop: 0 }}>What's next</h2>
        <p>
          Sign-in, roles and notifications are ready. The email editor, QA and sending arrive in the next milestones.
        </p>
      </div>
    </>
  );
}

// ---------- Account: change password ----------
export function AccountPage() {
  const { me } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('POST', '/api/auth/password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setMsg({ ok: true, text: 'Password changed. Your other sessions were signed out.' });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  }
  return (
    <>
      <h1>Account</h1>
      <p className="muted">{me?.user?.email}</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Change password</h2>
        <form onSubmit={submit}>
          <label htmlFor="cur">Current password</label>
          <input id="cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          <label htmlFor="new">New password</label>
          <input id="new" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
          {msg && <p className={msg.ok ? 'ok' : 'error'} role="alert">{msg.text}</p>}
          <p><button className="primary">Change password</button></p>
        </form>
      </div>
    </>
  );
}

// ---------- Admin: users ----------
export function UsersPage() {
  const { me } = useSession();
  const [users, setUsers] = useState<UserDto[]>([]);
  const [form, setForm] = useState<CreateUserRequest>({ email: '', name: '', role: 'builder' });
  const [invite, setInvite] = useState<{ name: string; url: string; expires: string } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => setUsers(await api<UserDto[]>('GET', '/api/users')), []);
  useEffect(() => { load().catch((e) => setError(errorText(e))); }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setError('');
    try { await fn(); await load(); } catch (e) { setError(errorText(e)); }
  }
  const showInvite = (r: InviteResponse) => setInvite({ name: r.user.name, url: r.inviteUrl, expires: new Date(r.expiresAt).toLocaleString() });

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      showInvite(await api<InviteResponse>('POST', '/api/users', form));
      setForm({ email: '', name: '', role: form.role });
    });
  }

  return (
    <>
      <h1>Users</h1>
      <div className="card wide">
        <h2 style={{ marginTop: 0 }}>Add a user</h2>
        <form onSubmit={create} className="row">
          <div><label htmlFor="n">Name</label><input id="n" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label htmlFor="e">Email</label><input id="e" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div>
            <label htmlFor="r">Role</label>
            <select id="r" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
          <div style={{ flex: '0 0 auto' }}><button className="primary">Create and get link</button></div>
        </form>
        {invite && (
          <div className="notice" role="status">
            <strong>One-time link for {invite.name}</strong> (valid until {invite.expires}). Send it to them yourself. It is shown only once.
            <div style={{ margin: '8px 0' }}><code>{invite.url}</code></div>
            <button onClick={() => void navigator.clipboard?.writeText(invite.url)}>Copy link</button>{' '}
            <button className="link" onClick={() => setInvite(null)}>Hide</button>
          </div>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <h2>Team</h2>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>2FA</th><th>Last sign-in</th><th>Actions</th></tr></thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === me?.user?.id;
              return (
                <tr key={u.id}>
                  <td>{u.name}<div className="muted">{u.email}</div></td>
                  <td>
                    <select aria-label={`Role for ${u.name}`} value={u.role} disabled={self}
                      onChange={(e) => void run(() => api('PATCH', `/api/users/${u.id}`, { role: e.target.value }))}>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </td>
                  <td><span className="badge">{u.status}</span>{u.lockedUntil && <div className="error">Locked</div>}</td>
                  <td>{u.twoFactorEnabled ? 'On' : 'Not set up'}</td>
                  <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                  <td>
                    <button className="link" onClick={() => void run(async () => showInvite(await api<InviteResponse>('POST', `/api/users/${u.id}/invite`)))}>
                      {u.status === 'invited' ? 'New setup link' : 'Reset password'}
                    </button>
                    {u.twoFactorEnabled && (
                      <button className="link" onClick={() => confirm(`Reset two-factor sign-in for ${u.name}? They will be signed out and set it up again.`) && void run(() => api('POST', `/api/users/${u.id}/reset-2fa`))}>Reset 2FA</button>
                    )}
                    {u.lockedUntil && <button className="link" onClick={() => void run(() => api('POST', `/api/users/${u.id}/unlock`))}>Unlock</button>}
                    {!self && (u.status === 'disabled'
                      ? <button className="link" onClick={() => void run(() => api('POST', `/api/users/${u.id}/enable`))}>Enable</button>
                      : <button className="link danger" onClick={() => confirm(`Disable ${u.name}? They are signed out immediately.`) && void run(() => api('POST', `/api/users/${u.id}/disable`))}>Disable</button>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------- Admin: activity ----------
const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.2fa_enrolled': 'Set up two-factor sign-in',
  'auth.recovery_code_used': 'Signed in with a recovery code',
  'auth.account_locked': 'Account locked after failed attempts',
  'auth.password_changed': 'Changed password',
  'user.created': 'User created',
  'user.invite_accepted': 'Accepted invitation',
  'user.invite_issued': 'New one-time link issued',
  'user.password_reset': 'Password reset completed',
  'user.role_changed': 'Role changed',
  'user.renamed': 'User renamed',
  'user.disabled': 'User disabled',
  'user.enabled': 'User enabled',
  'user.2fa_reset': 'Two-factor sign-in reset',
  'user.unlocked': 'Account unlocked',
};

export function ActivityPage() {
  const [rows, setRows] = useState<ActivityDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<ActivityDto[]>('GET', '/api/activity').then(setRows, (e) => setError(errorText(e))); }, []);
  return (
    <>
      <h1>Activity history</h1>
      <p className="muted">The most recent 200 events. This record cannot be edited or deleted.</p>
      {error && <p className="error">{error}</p>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td>{r.actorName ?? 'System'}</td>
                <td>{ACTION_LABELS[r.action] ?? r.action}</td>
                <td className="muted">{Object.entries(r.details).map(([k, v]) => `${k}: ${String(v)}`).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
