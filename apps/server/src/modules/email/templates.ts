// Plain-text email bodies (M10). Subjects are fixed strings: no user input in headers. Merchant-supplied text (names)
// only appears in bodies, which are plain text.

export interface Rendered {
  subject: string;
  text: string;
}

const footer = '\n\n-- \nGateway. You get this email because of activity on your account.';
const mode = (livemode: boolean) => (livemode ? 'live' : 'test');

export const templates = {
  verifyEmail: (url: string): Rendered => ({
    subject: 'Confirm your email address',
    text: `Confirm your email address to use live mode:\n\n${url}\n\nThe link works once and expires in 48 hours. If you did not create an account, ignore this email.${footer}`,
  }),
  passwordReset: (url: string): Rendered => ({
    subject: 'Reset your password',
    text: `Someone asked to reset the password of your account. If it was you, open this link within 1 hour:\n\n${url}\n\nIf it was not you, ignore this email; your password stays as it is.${footer}`,
  }),
  passwordChanged: (): Rendered => ({
    subject: 'Your password was changed',
    text: `The password of your account was just reset and every session was signed out.\n\nIf this was not you, contact support immediately.${footer}`,
  }),
  twoFactorReset: (): Rendered => ({
    subject: 'Two-factor authentication was reset',
    text: `Support reset two-factor authentication on your account and signed out every session. Set it up again under Security after signing in.\n\nIf you did not ask for this, contact support immediately.${footer}`,
  }),
  xpubChangeRequested: (p: { livemode: boolean; firstAddress: string; activatesAt: string; dashboardUrl: string }): Rendered => ({
    subject: 'Your payout wallet is about to change',
    text: `A new ${mode(p.livemode)} payout xpub was registered on your account (first address ${p.firstAddress}).\n\nIt replaces the current one at ${p.activatesAt}. Until then nothing changes.\n\nIf you did not do this, cancel it now under Payout wallet and change your password:\n${p.dashboardUrl}/#/xpub${footer}`,
  }),
  xpubChangeApplied: (p: { livemode: boolean; firstAddress: string }): Rendered => ({
    subject: 'Your payout wallet changed',
    text: `New ${mode(p.livemode)} invoices now pay to the xpub whose first address is ${p.firstAddress}.${footer}`,
  }),
  xpubChangeFailed: (p: { livemode: boolean; note: string }): Rendered => ({
    subject: 'Your payout wallet change did not apply',
    text: `The scheduled ${mode(p.livemode)} payout xpub change could not be applied: ${p.note}. The current xpub stays active.${footer}`,
  }),
  feeBalance: (p: { status: 'low' | 'blocked'; token: string; prepaid: string; symbol: string }): Rendered => ({
    subject: p.status === 'blocked' ? 'Live invoices paused: prepaid fees used up' : 'Prepaid fee balance is running low',
    text:
      p.status === 'blocked'
        ? `Your prepaid fee balance for ${p.token} is used up (${p.prepaid} ${p.symbol}). New live invoices in this token are refused until you top up.${footer}`
        : `Your prepaid fee balance for ${p.token} is ${p.prepaid} ${p.symbol}. Top up soon so new live invoices keep working.${footer}`,
  }),
};
