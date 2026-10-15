import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  PASSWORD_MIN_LENGTH,
  type EnrollConfirmResponse,
  type EnrollStartResponse,
  type InviteLookupResponse,
  type LoginResponse,
} from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="center-wrap">
      <div className="card">
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { refresh } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api<LoginResponse>('POST', '/api/auth/login', { email, password });
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Sign in">
      <p className="muted">Campaign LEGO is invite-only. Ask an Admin if you need an account.</p>
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <p><button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</button></p>
      </form>
    </Card>
  );
}

function CancelLink() {
  const { signOut } = useSession();
  return <button className="link" type="button" onClick={() => void signOut()}>Cancel and sign out</button>;
}

export function VerifyPage() {
  const { refresh } = useSession();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/auth/2fa/verify', useRecovery ? { recoveryCode: value } : { code: value });
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Two-factor sign-in">
      <p className="muted">
        {useRecovery ? 'Enter one of your saved recovery codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <form onSubmit={submit}>
        <label htmlFor="code">{useRecovery ? 'Recovery code' : 'Authenticator code'}</label>
        <input
          id="code"
          key={useRecovery ? 'r' : 'c'}
          autoFocus
          required
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && <p className="error" role="alert">{error}</p>}
        <p><button className="primary" disabled={busy}>Sign in</button></p>
      </form>
      <p>
        <button className="link" type="button" onClick={() => { setUseRecovery(!useRecovery); setValue(''); setError(''); }}>
          {useRecovery ? 'Use authenticator code instead' : 'Use a recovery code instead'}
        </button>
      </p>
      <CancelLink />
    </Card>
  );
}

export function EnrollPage() {
  const { refresh } = useSession();
  const [setup, setSetup] = useState<EnrollStartResponse | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // each call replaces the pending secret, so ask only once
    started.current = true;
    api<EnrollStartResponse>('POST', '/api/auth/2fa/enroll/start').then(setSetup, (e) => setError(errorText(e)));
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<EnrollConfirmResponse>('POST', '/api/auth/2fa/enroll/confirm', { code });
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (codes) {
    return (
      <Card title="Save your recovery codes">
        <p>
          If you lose your phone, each of these codes lets you sign in <strong>once</strong>. They are shown only now. Store them somewhere safe, such as a password manager.
        </p>
        <div className="notice codes">{codes.map((c) => <span key={c}>{c}</span>)}</div>
        <p>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>Copy codes</button>
        </p>
        <label style={{ fontWeight: 400 }}>
          <input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I have saved these codes
        </label>
        <p><button className="primary" disabled={!saved} onClick={() => void refresh()}>Continue</button></p>
      </Card>
    );
  }

  return (
    <Card title="Set up two-factor sign-in">
      <p className="muted">
        Two-factor sign-in is required. Scan the code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …), then enter the 6-digit code it shows.
      </p>
      {setup ? (
        <>
          <img className="qr" src={setup.qrDataUrl} alt="QR code to add this account to your authenticator app" width={220} height={220} />
          <details>
            <summary>Can't scan? Enter the key manually</summary>
            <p className="notice"><code>{setup.secret}</code></p>
          </details>
          <form onSubmit={confirm}>
            <label htmlFor="code">6-digit code</label>
            <input id="code" required inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            {error && <p className="error" role="alert">{error}</p>}
            <p><button className="primary">Confirm</button></p>
          </form>
        </>
      ) : (
        <p>{error ? <span className="error">{error}</span> : 'Preparing…'}</p>
      )}
      <CancelLink />
    </Card>
  );
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [invite, setInvite] = useState<InviteLookupResponse | null>(null);
  const [problem, setProblem] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<InviteLookupResponse>('GET', `/api/auth/invite/${encodeURIComponent(token)}`).then(setInvite, (e) => setProblem(errorText(e)));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPw) return setError('The two passwords do not match.');
    try {
      await api('POST', '/api/auth/invite/accept', { token, password });
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (done) {
    return (
      <Card title="Password saved">
        <p className="ok">Your password is set.</p>
        <p><a href="/login">Continue to sign in</a>. You will set up two-factor sign-in next.</p>
      </Card>
    );
  }
  if (problem) return <Card title="Link not valid"><p className="error">{problem}</p><p className="muted">Ask an Admin for a new link.</p></Card>;
  if (!invite) return <Card title="Set your password"><p>Checking your link…</p></Card>;

  return (
    <Card title="Set your password">
      <p className="muted">Welcome, {invite.name}. Choose a password for <strong>{invite.email}</strong>.</p>
      <form onSubmit={submit}>
        <label htmlFor="pw">New password</label>
        <input id="pw" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="muted" style={{ margin: '4px 0 0' }}>At least {PASSWORD_MIN_LENGTH} characters. A few random words work well.</p>
        <label htmlFor="pw2">Repeat password</label>
        <input id="pw2" type="password" autoComplete="new-password" required value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <p><button className="primary">Save password</button></p>
      </form>
    </Card>
  );
}
