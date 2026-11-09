import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { highlight, type Lang } from './highlight';
import { ICheck, ICopy } from './icons';

export interface CodeTab { label: string; lang: Lang; code: string }

function Highlighted(props: { code: string; lang: Lang; numbered: boolean }) {
  const tokens = useMemo(() => highlight(props.code, props.lang), [props.code, props.lang]);
  const lines = props.code.split('\n').length;
  const body = (
    <code>
      {tokens.map((t, i) => (t.k ? <span key={i} className={`tk-${t.k}`}>{t.v}</span> : t.v))}
    </code>
  );
  if (!props.numbered) return <pre tabIndex={0}>{body}</pre>;
  return (
    <pre className="numbered" tabIndex={0}>
      <span className="ln" aria-hidden="true">{Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n')}</span>
      {body}
    </pre>
  );
}

function CopyButton(props: { text: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => {
    window.clearTimeout(timer.current);
  }, []);
  const copy = () => {
    const ok = () => {
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setDone(false);
      }, 1600);
    };
    if (typeof navigator.clipboard !== 'undefined') {
      navigator.clipboard.writeText(props.text).then(ok, () => {
        setDone(false);
      });
    }
  };
  return (
    <button type="button" className={`copy ${done ? 'done' : ''}`} onClick={copy} aria-label={done ? 'Copied' : 'Copy code'}>
      {done ? <ICheck /> : <ICopy />}
      <span>{done ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/** A code window: one snippet, or tabs of snippets. */
export function CodeWindow(props: {
  tabs: CodeTab[];
  title?: string;
  chrome?: boolean;
  numbered?: boolean;
  glow?: boolean;
  compact?: boolean;
  footer?: ReactNode;
  className?: string;
}) {
  const [active, setActive] = useState(0);
  const id = useId();
  const tab = props.tabs[Math.min(active, props.tabs.length - 1)];
  if (!tab) return null;
  const multi = props.tabs.length > 1;
  const cls = ['codewin', props.glow ? 'glow' : '', props.compact ? 'compact' : '', props.className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <div className="codewin-head">
        {props.chrome !== false && (
          <span className="lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        {multi ? (
          <div className="codewin-tabs" role="tablist" aria-label={props.title ?? 'Code samples'}>
            {props.tabs.map((t, i) => (
              <button
                key={t.label}
                type="button"
                role="tab"
                id={`${id}-t${String(i)}`}
                aria-selected={i === active}
                aria-controls={`${id}-p`}
                onClick={() => {
                  setActive(i);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="codewin-title">{props.title ?? tab.label}</span>
        )}
        <CopyButton text={tab.code} />
      </div>
      <div id={`${id}-p`} role={multi ? 'tabpanel' : undefined} aria-labelledby={multi ? `${id}-t${String(active)}` : undefined}>
        <Highlighted code={tab.code} lang={tab.lang} numbered={props.numbered ?? false} />
      </div>
      {props.footer}
    </div>
  );
}

export function Code(props: { lang: Lang; children: string; title?: string; numbered?: boolean; compact?: boolean }) {
  return (
    <CodeWindow
      tabs={[{ label: props.title ?? props.lang, lang: props.lang, code: props.children }]}
      chrome={false}
      {...(props.title === undefined ? {} : { title: props.title })}
      {...(props.numbered === undefined ? {} : { numbered: props.numbered })}
      {...(props.compact === undefined ? {} : { compact: props.compact })}
    />
  );
}
