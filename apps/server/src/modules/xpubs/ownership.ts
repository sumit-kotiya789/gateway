// MONEY-CRITICAL
// Ownership proof for a merchant xpub (D-075): the merchant signs a challenge (EIP-191 personal_sign) with the key of
// the first deposit address, account/0/0. Only someone holding the private keys behind the xpub can produce it, so a
// mistyped, copied or attacker-supplied xpub cannot be registered for live payments. Stateless: the challenge is rebuilt
// from the request and must be recent.
import { AppError } from '@gw/core';
import { recoverMessageAddress, type Hex } from 'viem';

/** How long a signed challenge stays usable, and how far ahead of our clock its timestamp may be. */
export const PROOF_MAX_AGE_MS = 15 * 60_000;
const PROOF_MAX_SKEW_MS = 60_000;

export interface Challenge {
  merchantId: string;
  livemode: boolean;
  fingerprint: string;
  address: string;
  issuedAt: string;
}

export function ownershipMessage(c: Challenge): string {
  return [
    'Gateway payout wallet ownership proof',
    '',
    `I control this wallet and want it to receive my ${c.livemode ? 'live' : 'test'} payments.`,
    '',
    `Merchant: ${c.merchantId}`,
    `Key fingerprint: ${c.fingerprint}`,
    `Address (0/0): ${c.address}`,
    `Issued at: ${c.issuedAt}`,
  ].join('\n');
}

/** Throws unless `signature` is address 0/0's signature over this exact, recent challenge. */
export async function verifyOwnership(c: Challenge, signature: string, now: number): Promise<void> {
  const issued = Date.parse(c.issuedAt);
  if (!Number.isFinite(issued) || issued > now + PROOF_MAX_SKEW_MS || now - issued > PROOF_MAX_AGE_MS) {
    throw new AppError('validation_error', 'ownership challenge expired; sign a new one', { reason: 'proof_expired' });
  }
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: ownershipMessage(c), signature: signature as Hex });
  } catch {
    throw new AppError('validation_error', 'ownership signature is invalid', { reason: 'proof_invalid' });
  }
  if (signer.toLowerCase() !== c.address.toLowerCase()) {
    throw new AppError('validation_error', 'ownership signature is not from the first address of this xpub', { reason: 'proof_mismatch' });
  }
}
