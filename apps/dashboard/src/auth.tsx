import { useState, type ChangeEvent } from 'react';
import { api } from './api';
import { ErrorBox, Field, useAction } from './ui';

type LoginResult = { mfa_required: false } | { mfa_required: true; mfa_token: string };

export function Login(props: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string>();
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [signup, setSignup] = useState(false);
  const [forgot, setForgot] = useState(false);
  const a = useAction();

  if (signup) return <Signup onDone={props.onDone} onBack={() => { setSignup(false); }} />;
  if (forgot) return <ForgotPassword onBack={() => { setForgot(false); }} />;

  if (mfaToken) {
    return (
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
        <h1>Two-factor authentication</h1>
        <Field label={useRecovery ? 'Recovery code' : 'Authenticator code'}>
          <input value={code} onChange={(e) => { setCode(e.target.value); }} autoComplete="one-time-code" autoFocus required />
        </Field>
        <ErrorBox error={a.error} />
        <button disabled={a.busy}>Verify</button>
        <button type="button" className="link" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>
          {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
        </button>
      </form>
    );
  }

  return (
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
      <h1>Sign in</h1>
      <Field label="Email">
        <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} autoComplete="username" autoFocus required />
      </Field>
      <Field label="Password">
        <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="current-password" required />
      </Field>
      <ErrorBox error={a.error} />
      <button disabled={a.busy}>Sign in</button>
      <button type="button" className="link" onClick={() => { setForgot(true); }}>
        Forgot password?
      </button>
      <button type="button" className="link" onClick={() => { setSignup(true); }}>
        Create an account
      </button>
    </form>
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
          props.onDone();
        });
      }}
    >
      <h1>Create account</h1>
      <Field label="Business name">
        <input value={form.merchant_name} onChange={set('merchant_name')} maxLength={200} autoFocus required />
      </Field>
      <Field label="Email">
        <input type="email" value={form.email} onChange={set('email')} autoComplete="username" required />
      </Field>
      <Field label="Password" hint="At least 12 characters.">
        <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={12} maxLength={128} required />
      </Field>
      <ErrorBox error={a.error} />
      <button disabled={a.busy}>Create account</button>
      <button type="button" className="link" onClick={props.onBack}>
        I already have an account
      </button>
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
        <p>If an account exists for {email}, a reset link is on its way. It works for 1 hour.</p>
      ) : (
        <>
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => { setEmail(e.target.value); }} autoComplete="username" autoFocus required />
          </Field>
          <ErrorBox error={a.error} />
          <button disabled={a.busy}>Send reset link</button>
        </>
      )}
      <button type="button" className="link" onClick={props.onBack}>
        Back to sign in
      </button>
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
      <div className="auth card">
        <h1>Password changed</h1>
        <p>Every session was signed out. Sign in with your new password.</p>
        <a href="#/">Sign in</a>
      </div>
    );
  }
  return (
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
      <Field label="New password" hint="At least 12 characters.">
        <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="new-password" minLength={12} maxLength={128} autoFocus required />
      </Field>
      <Field label="Authenticator or recovery code" hint="Only if two-factor authentication is on.">
        <input value={code} onChange={(e) => { setCode(e.target.value); }} autoComplete="one-time-code" />
      </Field>
      <ErrorBox error={a.error} />
      <button disabled={a.busy}>Set password</button>
    </form>
  );
}

export function VerifyEmail(props: { token: string; onDone: () => void }) {
  const a = useAction();
  const [done, setDone] = useState(false);
  return (
    <div className="auth card">
      <h1>Confirm your email</h1>
      {done ? (
        <>
          <p>Your email address is confirmed.</p>
          <a href="#/" onClick={props.onDone}>Continue</a>
        </>
      ) : (
        <>
          <ErrorBox error={a.error} />
          <button
            disabled={a.busy}
            onClick={() => {
              void a.run(async () => {
                await api('POST', '/auth/verify-email', { token: props.token });
                setDone(true);
              });
            }}
          >
            Confirm email address
          </button>
        </>
      )}
    </div>
  );
}

/** Shown until the user's email is verified: live mode needs it. */
export function VerifyBanner() {
  const a = useAction();
  const [sent, setSent] = useState(false);
  return (
    <p className="notice">
      Confirm your email address to use live mode: check your inbox.{' '}
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
            });
          }}
        >
          Send a new link
        </button>
      )}
      {a.error && <span className="warn-text"> {a.error}</span>}
    </p>
  );
}
