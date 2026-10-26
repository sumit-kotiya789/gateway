import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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

// ---------------------------------------------------------------- icons (24px stroke set, Lucide-style shapes, ISC)

const ICONS = {
  invoice: 'M6 2h12v20l-3-2-3 2-3-2-3 2V2z M9 7h6 M9 11h6 M9 15h4',
  key: 'M21 2l-2 2 M11.4 11.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78z M11.4 11.6L15.5 7.5 M15.5 7.5l3 3L22 7l-3-3 M15.5 7.5L19 4',
  zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  widget: 'M3 3h18v18H3z M3 9h18 M9 21V9',
  wallet: 'M20 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15v12H5a2 2 0 0 1-2-2V6 M16.5 14h.01',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
  plus: 'M12 5v14 M5 12h14',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  check: 'M20 6L9 17l-5-5',
  alert: 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
  error: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M15 9l-6 6 M9 9l6 6',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01',
  success: 'M22 11.1V12a10 10 0 1 1-5.9-9.1 M22 4L12 14l-3-3',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  x: 'M18 6L6 18 M6 6l12 12',
  back: 'M19 12H5 M12 19l-7-7 7-7',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3',
  refresh: 'M21 12a9 9 0 0 1-15.5 6.2L3 16 M3 12a9 9 0 0 1 15.5-6.2L21 8 M21 3v5h-5 M3 21v-5h5',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6',
  trash: 'M3 6h18 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6 M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  loader: 'M21 12a9 9 0 1 1-6.2-8.6',
  trend: 'M23 6l-9.5 9.5-5-5L1 18 M17 6h6v6',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
  coins: 'M9 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M18.1 10.4A6 6 0 1 1 10.4 18.1 M7 6h1v4 M16.7 13.9l.7.7-2.8 2.8',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.35-4.35',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  store: 'M3 9l2-5h14l2 5 M3 9h18 M3 9a3 3 0 0 0 6 0a3 3 0 0 0 6 0a3 3 0 0 0 6 0 M5 12v9h14v-9 M10 21v-5h4v5',
  power: 'M18.36 6.64a9 9 0 1 1-12.73 0 M12 2v10',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon(props: { name: IconName; size?: number; className?: string }) {
  const s = props.size ?? 18;
  return (
    <svg
      className={props.className}
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[props.name]} />
    </svg>
  );
}

export function BrandMark(props: { className?: string }) {
  const id = useId();
  return (
    <svg className={props.className ?? 'brand-mark'} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7dff9b" />
          <stop offset="1" stopColor="#0d7f2a" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill={`url(#${id})`} />
      <path d="M27.5 14.2A9 9 0 1 0 29 22h-8.5" fill="none" stroke="#031007" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------- feedback: alerts, toasts, modal

type Tone = 'info' | 'success' | 'warning' | 'error';
const TONE_ICON: Record<Tone, IconName> = { info: 'info', success: 'success', warning: 'alert', error: 'error' };

export function Alert(props: { tone?: Tone; children: ReactNode }) {
  const tone = props.tone ?? 'info';
  return (
    <div className={`alert ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={TONE_ICON[tone]} />
      <div className="alert-body">{props.children}</div>
    </div>
  );
}

export const ErrorBox = (props: { error?: string | undefined }) => (props.error ? <Alert tone="error">{props.error}</Alert> : null);

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  text?: string | undefined;
  leaving?: boolean;
}
let toasts: ToastItem[] = [];
let toastSeq = 0;
const toastSubs = new Set<() => void>();
const emitToasts = () => {
  for (const s of toastSubs) s();
};
function dismissToast(id: number) {
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  }, 250);
}
function pushToast(kind: ToastKind, title: string, text?: string) {
  const id = ++toastSeq;
  toasts = [...toasts.slice(-3), { id, kind, title, text }];
  emitToasts();
  setTimeout(() => {
    dismissToast(id);
  }, kind === 'error' ? 7000 : 4000);
}
/** Pop-up notifications (bottom right). Render <Toaster /> once at the app root. */
export const toast = {
  success: (title: string, text?: string) => {
    pushToast('success', title, text);
  },
  error: (title: string, text?: string) => {
    pushToast('error', title, text);
  },
  info: (title: string, text?: string) => {
    pushToast('info', title, text);
  },
};

const subscribeToasts = (cb: () => void) => {
  toastSubs.add(cb);
  return () => {
    toastSubs.delete(cb);
  };
};

export function Toaster() {
  const list = useSyncExternalStore(subscribeToasts, () => toasts);
  return (
    <div className="toaster" role="region" aria-label="Notifications" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}${t.leaving ? ' leaving' : ''}`}>
          <Icon name={t.kind === 'success' ? 'success' : t.kind === 'error' ? 'error' : 'info'} size={20} />
          <div className="toast-body">
            <strong>{t.title}</strong>
            {t.text}
          </div>
          <button type="button" className="ghost" aria-label="Dismiss" onClick={() => { dismissToast(t.id); }}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Modal(props: { title: string; icon?: IconName; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    box.current?.querySelector<HTMLElement>('[data-autofocus], button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box}>
        {props.icon && (
          <div className="modal-icon">
            <Icon name={props.icon} size={22} />
          </div>
        )}
        <h3 id={titleId}>{props.title}</h3>
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

/** Destructive action behind a confirmation dialog. */
export function ConfirmButton(props: {
  label: string;
  /** Dialog title (defaults to "<label>?"). */
  confirm?: string;
  message?: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="danger-outline sm" disabled={props.disabled} onClick={() => { setOpen(true); }}>
        {props.label}
      </button>
      {open && (
        <Modal title={props.confirm ?? `${props.label}?`} icon="alert" onClose={() => { setOpen(false); }}>
          <p>{props.message ?? 'This cannot be undone.'}</p>
          <div className="row">
            <button type="button" className="secondary" onClick={() => { setOpen(false); }}>Keep it</button>
            <button
              type="button"
              className="danger"
              data-autofocus
              onClick={() => {
                setOpen(false);
                props.onConfirm();
              }}
            >
              {props.label}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- form pieces

export function Field(props: { label: string; hint?: string; narrow?: boolean; children: ReactNode }) {
  return (
    <label className={props.narrow ? 'field narrow' : 'field'}>
      <span>{props.label}</span>
      {props.children}
      {props.hint && <small>{props.hint}</small>}
    </label>
  );
}

export function TotpInput(props: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Authenticator code" hint="Fresh 6-digit code from your authenticator app." narrow>
      <input
        value={props.value}
        onChange={(e) => {
          props.onChange(e.target.value.replace(/\D/g, '').slice(0, 6));
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        placeholder="123456"
        required
      />
    </Field>
  );
}

/** Primary submit button with a spinner while busy. */
export function Submit(props: { busy: boolean; disabled?: boolean; children: ReactNode; className?: string }) {
  return (
    <button className={props.className} disabled={props.busy || props.disabled}>
      {props.busy && <Icon name="loader" className="spin" size={16} />}
      {props.children}
    </button>
  );
}

export function CopyButton(props: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="secondary sm"
      onClick={() => {
        void navigator.clipboard.writeText(props.value).then(() => {
          setDone(true);
          toast.success('Copied to clipboard');
          setTimeout(() => {
            setDone(false);
          }, 1500);
        });
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
      {props.label ?? (done ? 'Copied' : 'Copy')}
    </button>
  );
}

export function CopyField(props: { value: string }) {
  return (
    <span className="copy-field">
      <code>{props.value}</code>
      <CopyButton value={props.value} />
    </span>
  );
}

/** Shows a secret that will never be shown again, with a copy button. */
export function SecretOnce(props: { label: string; value: string; onDone: () => void }) {
  return (
    <div className="secret" role="status">
      <strong>{props.label}</strong>
      <p className="muted">Copy it now. It will not be shown again.</p>
      <code>{props.value}</code>
      <div className="row">
        <CopyButton value={props.value} />
        <button type="button" className="secondary sm" onClick={props.onDone}>
          I saved it
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- display

export function EmptyState(props: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={props.icon} size={24} />
      </div>
      <h4>{props.title}</h4>
      {props.children}
    </div>
  );
}

export function Skeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      <div />
      <div />
      <div />
    </div>
  );
}

export function Stat(props: { label: string; value: string; unit?: string | null; icon?: IconName; tone?: 'warn' | 'bad'; children?: ReactNode }) {
  return (
    <div className={`stat${props.tone ? ` ${props.tone}` : ''}`}>
      <span className="stat-label">
        {props.icon && <Icon name={props.icon} size={14} />}
        {props.label}
      </span>
      <span className="stat-value num">
        {props.value}
        {props.unit && <small>{props.unit}</small>}
      </span>
      {props.children && <span className="stat-foot">{props.children}</span>}
    </div>
  );
}

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
export const short = (s: string, n = 6) => (s.length > 2 * n + 1 ? `${s.slice(0, n + 2)}…${s.slice(-n)}` : s);

export const StatusBadge = (props: { status: string }) => <span className={`badge s-${props.status}`}>{props.status.replace(/_/g, ' ')}</span>;
