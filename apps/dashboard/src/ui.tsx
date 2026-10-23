import { useEffect, useState, type ReactNode } from 'react';

// Shared by the admin console (apps/admin imports this file): keep it free of app-specific imports.
export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'something went wrong');

/** Loads data when `deps` change; `reload()` refetches. */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => {
        if (live) setState({ data });
      },
      (e: unknown) => {
        if (live) setState({ error: errorText(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, n]); // caller declares deps
  return {
    ...state,
    reload: () => {
      setN((x) => x + 1);
    },
  };
}

/** Runs a form action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
      {props.hint && <small>{props.hint}</small>}
    </label>
  );
}

export function TotpInput(props: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Authenticator code" hint="Fresh 6-digit code from your authenticator app.">
      <input
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value.replace(/\D/g, '').slice(0, 6));
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        required
      />
    </Field>
  );
}

export const ErrorBox = (props: { error?: string | undefined }) =>
  props.error ? (
    <p className="error" role="alert">
      {props.error}
    </p>
  ) : null;

/** Shows a secret that will never be shown again, with a copy button. */
export function SecretOnce(props: { label: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret" role="status">
      <strong>{props.label}</strong>
      <p>Copy it now. It will not be shown again.</p>
      <code>{props.value}</code>
      <div className="row">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(props.value).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="secondary" onClick={props.onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Two-click destructive button: first click arms, second confirms. */
export function ConfirmButton(props: { label: string; confirm: string; onConfirm: () => void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={armed ? 'danger' : 'secondary'}
      disabled={props.disabled}
      onBlur={() => {
        setArmed(false);
      }}
      onClick={() => {
        if (armed) props.onConfirm();
        setArmed(!armed);
      }}
    >
      {armed ? props.confirm : props.label}
    </button>
  );
}

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
export const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);

export const StatusBadge = (props: { status: string }) => <span className={`badge s-${props.status}`}>{props.status.replace('_', ' ')}</span>;
