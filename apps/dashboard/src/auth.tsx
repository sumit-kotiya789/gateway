import { useState, type ChangeEvent, type ReactNode } from 'react';
import { api } from './api';
import { Alert, BrandMark, ErrorBox, Field, Submit, toast, useAction } from './ui';

type LoginResult = { mfa_required: false } | { mfa_required: true; mfa_token: string };

/** Split screen for signed-out pages: brand hero on the left, the form card on the right. */
function AuthShell(props: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <section className="auth-hero">
        <div className="brand">
          <BrandMark />
          <div>
            Gateway
            <small>Crypto payments, non-custodial</small>
          </div>
        </div>
        <div>
          <h1>
            Seamless stablecoin payments, <span>straight to your wallet.</span>
          </h1>
          <p>Invoices, hosted checkout and webhooks for USDT. Every payment lands in addresses only you control.</p>
          <div className="chips">
            <div className="chip">
              <strong>0 keys</strong>
              <span>held by us</span>
            </div>
            <div className="chip">
              <strong>Seconds</strong>
              <span>to detect payments</span>
            </div>
            <div className="chip">
              <strong>2FA</strong>
              <span>on every sensitive change</span>
            </div>
          </div>
        </div>
        <small className="muted">Signed webhooks · Reorg-safe confirmations · Audited ledger</small>
      </section>
      <section className="auth-panel">{props.children}</section>
    </div>
  );
}

/** Centered card for pages opened from an email link. */
function Solo(props: { children: ReactNode }) {
  return (
    <div className="auth-solo">
      <div className="card auth">{props.children}</div>
    </div>
  );
}

export function Login(props: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string>();
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [signup, setSignup] = useState(false);
  const [forgot, setForgot] = useState(false);
  const a = useAction();

  if (signup) return <AuthShell><Signup onDone={props.onDone} onBack={() => { setSignup(false); }} /></AuthShell>;
  if (forgot) return <AuthShell><ForgotPassword onBack={() => { setForgot(false); }} /></AuthShell>;

  if (mfaToken) {
    return (
      <AuthShell>
        <form
          className="auth card"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              await api('POST', '/auth/login/2fa', useRecovery ? { mfa_token: mfaToken, recovery_code: code } : { mfa_token: mfaToken, code });
              props.onDone();
            });
          }}
        >
          <h1>Two-factor check</h1>
          <p className="lede">{useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}</p>
          <Field label={useRecovery ? 'Recovery code' : 'Authenticator code'}>
            <input value={code} onChange={(e) => { setCode(e.target.value); }} autoComplete="one-time-code" placeholder={useRecovery ? 'xxxx-xxxx-xxxx-xxxx' : '123456'} autoFocus required />
          </Field>
          <ErrorBox error={a.error} />
          <Submit busy={a.busy}>Verify and sign in</Submit>
          <div className="links">
            <button type="button" className="link" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>
              {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
            </button>
            <button type="button" className="link" onClick={() => { setMfaToken(undefined); setCode(''); }}>Back</button>
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form
        className="auth card"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const r = await api<LoginResult>('POST', '/auth/login', { email, password });
            if (r.mfa_required) setMfaToken(r.mfa_token);
            else props.onDone();
          });
        }}
      >
        <h1>Welcome back</h1>
        <p className="lede">Sign in to manage invoices, payouts and your team.</p>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} autoComplete="username" placeholder="you@company.com" autoFocus required />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="current-password" placeholder="••••••••••••" required />
        </Field>
        <ErrorBox error={a.error} />
        <Submit busy={a.busy}>Sign in</Submit>
        <div className="links">
          <button type="button" className="link" onClick={() => { setForgot(true); }}>Forgot password?</button>
          <button type="button" className="link" onClick={() => { setSignup(true); }}>Create an account</button>
        </div>
      </form>
    </AuthShell>
  );
}

function Signup(props: { onDone: () => void; onBack: () => void }) {
  const [form, setForm] = useState({ merchant_name: '', email: '', password: '' });
  const a = useAction();
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.target.value });
  };
  return (
    <form
      className="auth card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await api('POST', '/auth/signup', form);
          toast.success('Account created', 'Check your inbox to confirm your email address.');
          props.onDone();
        });
      }}
    >
      <h1>Create your account</h1>
      <p className="lede">Start in test mode right away. Live mode needs a confirmed email.</p>
      <Field label="Business name">
        <input value={form.merchant_name} onChange={set('merchant_name')} maxLength={200} placeholder="Acme Store" autoFocus required />
      </Field>
      <Field label="Work email">
        <input type="email" value={form.email} onChange={set('email')} autoComplete="username" placeholder="you@company.com" required />
      </Field>
      <Field label="Password" hint="At least 12 characters.">
        <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={12} maxLength={128} required />
      </Field>
      <ErrorBox error={a.error} />
      <Submit busy={a.busy}>Create account</Submit>
      <div className="links">
        <button type="button" className="link" onClick={props.onBack}>I already have an account</button>
      </div>
    </form>
  );
}

function ForgotPassword(props: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const a = useAction();
  return (
    <form
      className="auth card"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          await api('POST', '/auth/password/forgot', { email });
          setSent(true);
        });
      }}
    >
      <h1>Reset password</h1>
      {sent ? (
        <Alert tone="success">If an account exists for {email}, a reset link is on its way. It works for 1 hour.</Alert>
      ) : (
        <>
          <p className="lede">We will email you a link to choose a new password.</p>
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} autoComplete="username" placeholder="you@company.com" autoFocus required />
          </Field>
          <ErrorBox error={a.error} />
          <Submit busy={a.busy}>Send reset link</Submit>
        </>
      )}
      <div className="links">
        <button type="button" className="link" onClick={props.onBack}>Back to sign in</button>
      </div>
    </form>
  );
}

/** Token from the emailed link (`#/page?token=...`). The hash never reaches a server or a Referer header. */
export function linkToken(hash: string): string {
  return new URLSearchParams(hash.split('?')[1] ?? '').get('token') ?? '';
}

export function ResetPassword(props: { token: string }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const a = useAction();
  if (done) {
    return (
      <Solo>
        <h1>Password changed</h1>
        <Alert tone="success">Every session was signed out. Sign in with your new password.</Alert>
        <a className="btn" href="#/">Sign in</a>
      </Solo>
    );
  }
  return (
    <div className="auth-solo">
      <form
        className="auth card"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const c = code.trim();
            const second = c === '' ? {} : /^\d{6}$/.test(c) ? { code: c } : { recovery_code: c };
            await api('POST', '/auth/password/reset', { token: props.token, password, ...second });
            setDone(true);
          });
        }}
      >
        <h1>Choose a new password</h1>
        <p className="lede">This signs you out everywhere else.</p>
        <Field label="New password" hint="At least 12 characters.">
          <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="new-password" minLength={12} maxLength={128} autoFocus required />
        </Field>
        <Field label="Authenticator or recovery code" hint="Only if two-factor authentication is on.">
          <input value={code} onChange={(e) => { setCode(e.target.value); }} autoComplete="one-time-code" />
        </Field>
        <ErrorBox error={a.error} />
        <Submit busy={a.busy}>Set password</Submit>
      </form>
    </div>
  );
}

export function VerifyEmail(props: { token: string; onDone: () => void }) {
  const a = useAction();
  const [done, setDone] = useState(false);
  return (
    <Solo>
      <h1>Confirm your email</h1>
      {done ? (
        <>
          <Alert tone="success">Your email address is confirmed. Live mode is unlocked.</Alert>
          <a className="btn" href="#/" onClick={props.onDone}>Continue to dashboard</a>
        </>
      ) : (
        <>
          <p className="lede">One click and you can use live mode.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await api('POST', '/auth/verify-email', { token: props.token });
                setDone(true);
              });
            }}
          >
            <ErrorBox error={a.error} />
            <Submit busy={a.busy}>Confirm email address</Submit>
          </form>
        </>
      )}
    </Solo>
  );
}

/** Shown until the user's email is verified: live mode needs it. */
export function VerifyBanner() {
  const a = useAction();
  const [sent, setSent] = useState(false);
  return (
    <Alert tone="info">
      Confirm your email address to use live mode. Check your inbox.{' '}
      {sent ? (
        'A new link is on its way.'
      ) : (
        <button
          className="link"
          disabled={a.busy}
          onClick={() => {
            void a.run(async () => {
              await api('POST', '/auth/verify-email/resend');
              setSent(true);
              toast.success('Verification email sent');
            });
          }}
        >
          Send a new link
        </button>
      )}
      {a.error && <span className="warn-text"> {a.error}</span>}
    </Alert>
  );
}
