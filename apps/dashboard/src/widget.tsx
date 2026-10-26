import { useEffect, useState } from 'react';
import { api } from './api';
import { ErrorBox, Field, useAction, useLoad } from './ui';

/** Checkout widget: which sites may embed the hosted checkout, and the snippet to do it. */
export function Widget(props: { canManage: boolean; apiOrigin: string }) {
  const settings = useLoad(() => api<{ widget_origins: string[] }>('GET', '/settings/'), []);
  const [text, setText] = useState('');
  const a = useAction();
  useEffect(() => {
    if (settings.data) setText(settings.data.widget_origins.join('\n'));
  }, [settings.data]);
  const snippet = `<script src="${props.apiOrigin}/widget.js"></script>
<script>
  // invoiceId: created by your backend with your secret key (POST /v1/invoices).
  GatewayCheckout.open({
    invoiceId: '<invoice id>',
    onPaid: () => { /* show "thank you"; fulfil the order from the webhook, not from here */ },
    onClose: () => {},
  });
</script>`;
  return (
    <section>
      <header className="page-head"><h2>Checkout widget</h2></header>
      <p>Open the hosted checkout in a dialog on your own site instead of redirecting. Only the sites listed here can embed it.</p>
      <ErrorBox error={settings.error} />
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            const origins = text.split(/\s+/).filter(Boolean);
            await api('PUT', '/settings/widget-origins', { widget_origins: origins });
            settings.reload();
          });
        }}
      >
        <Field label="Allowed sites" hint="One origin per line, like https://shop.example (no path). Up to 10.">
          <textarea rows={4} value={text} onChange={(e) => { setText(e.target.value); }} disabled={!props.canManage} spellCheck={false} />
        </Field>
        <ErrorBox error={a.error} />
        {props.canManage && <button disabled={a.busy}>Save</button>}
      </form>
      <h3>Snippet</h3>
      <pre className="challenge">{snippet}</pre>
      <p className="muted">The widget reports status to your page for display only. Confirm payment from a webhook or GET /v1/invoices/:id before fulfilling.</p>
    </section>
  );
}
