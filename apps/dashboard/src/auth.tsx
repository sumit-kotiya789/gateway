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
  const a = useAction();

  if (signup) return <Signup onDone={props.onDone} onBack={() => { setSignup(false); }} />;

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
