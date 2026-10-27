// Plain-text email bodies (M10). Subjects are fixed strings: no user input in headers. Merchant-supplied text (names)
// only appears in bodies, which are plain text.

export interface Rendered {
  subject: string;
  text: string;
}

const footer = '\n\n-- \nGateway. You get this email because of activity on your account.';
const mode = (livemode: boolean) => (livemode ? 'live' : 'test');
/** Client-supplied text (a User-Agent header): one line of printable characters, capped. */
const printable = (s: string, max: number) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, max);

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
  newDeviceLogin: (p: { at: string; ip: string; userAgent: string | null; dashboardUrl: string }): Rendered => ({
    subject: 'New sign-in to your account',
    text: `Your account was just signed in to from a browser we have not seen before.\n\nTime: ${p.at}\nIP address: ${p.ip}\nBrowser: ${printable(p.userAgent ?? 'unknown', 200)}\n\nIf this was you, there is nothing to do. If not, reset your password now ("Forgot password" on the sign-in page) and turn on two-factor authentication:\n${p.dashboardUrl}${footer}`,
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
  teamInvite: (p: { merchantName: string; role: string; url: string }): Rendered => ({
    subject: 'You are invited to a Gateway account',
    text: `You are invited to join "${p.merchantName}" on Gateway as ${p.role.replace('_', ' ')}.\n\nAccept and choose a password:\n${p.url}\n\nThe link works once and expires in 7 days. If you did not expect this, ignore it.${footer}`,
  }),
  memberRemoved: (p: { merchantName: string }): Rendered => ({
    subject: 'You were removed from a Gateway account',
    text: `You no longer have access to "${p.merchantName}" on Gateway and were signed out.${footer}`,
  }),
  payoutAddressAdded: (p: { livemode: boolean; address: string; activatesAt: string; dashboardUrl: string }): Rendered => ({
    subject: 'A new payout address was added',
    text: `A new ${mode(p.livemode)} payout address was added to your account: ${p.address}\n\nWithdrawals go there from ${p.activatesAt}. Until then nothing changes.\n\nIf you did not do this, cancel it now under Withdrawals and change your password:\n${p.dashboardUrl}/#/withdrawals${footer}`,
  }),
  withdrawalRequested: (p: { livemode: boolean; amount: string; symbol: string; address: string }): Rendered => ({
    subject: 'Withdrawal requested',
    text: `A ${mode(p.livemode)} withdrawal of ${p.amount} ${p.symbol} to ${p.address} was requested.\n\nIf you did not do this, cancel it in the dashboard (while it awaits approval), change your password and contact support.${footer}`,
  }),
  withdrawalDone: (p: { status: 'confirmed' | 'failed' | 'rejected'; amount: string; symbol: string; address: string; txHash: string | null; reason: string | null }): Rendered => ({
    subject: p.status === 'confirmed' ? 'Withdrawal sent' : 'Withdrawal not sent',
    text:
      p.status === 'confirmed'
        ? `Your withdrawal of ${p.amount} ${p.symbol} to ${p.address} is confirmed on chain (transaction ${p.txHash ?? ''}).${footer}`
        : `Your withdrawal of ${p.amount} ${p.symbol} to ${p.address} was ${p.status}${p.reason ? `: ${p.reason}` : ''}. The amount is available again.${footer}`,
  }),
  feeBalance: (p: { status: 'low' | 'blocked'; token: string; prepaid: string; symbol: string }): Rendered => ({
    subject: p.status === 'blocked' ? 'Live invoices paused: prepaid fees used up' : 'Prepaid fee balance is running low',
    text:
      p.status === 'blocked'
        ? `Your prepaid fee balance for ${p.token} is used up (${p.prepaid} ${p.symbol}). New live invoices in this token are refused until you top up.${footer}`
        : `Your prepaid fee balance for ${p.token} is ${p.prepaid} ${p.symbol}. Top up soon so new live invoices keep working.${footer}`,
  }),
};
