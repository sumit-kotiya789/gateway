// Authorization model. Server-side checks on every route use these tables; nothing else grants access.

export const MERCHANT_ROLES = ['owner', 'admin', 'developer', 'finance', 'read_only'] as const;
export type MerchantRole = (typeof MERCHANT_ROLES)[number];

const ALL: readonly MerchantRole[] = MERCHANT_ROLES;

export const MERCHANT_PERMISSIONS = {
  'account:read': ALL,
  'invoices:read': ALL,
  'reports:read': ['owner', 'admin', 'finance', 'read_only'],
  'invoices:write': ['owner', 'admin', 'developer', 'finance'],
  'api_keys:read': ['owner', 'admin', 'developer'],
  'api_keys:write': ['owner', 'admin', 'developer'],
  'webhooks:manage': ['owner', 'admin', 'developer'],
  'refunds:write': ['owner', 'admin', 'finance'],
  'withdrawals:request': ['owner', 'finance'],
  'payouts:manage': ['owner'],
  'custody:manage': ['owner'],
  'team:manage': ['owner', 'admin'],
  'settings:manage': ['owner', 'admin'],
  'audit:read': ['owner', 'admin'],
} as const satisfies Record<string, readonly MerchantRole[]>;

export type MerchantPermission = keyof typeof MERCHANT_PERMISSIONS;

export function roleCan(role: MerchantRole, permission: MerchantPermission): boolean {
  return (MERCHANT_PERMISSIONS[permission] as readonly MerchantRole[]).includes(role);
}

/** Scopes for secret keys. Publishable keys always carry exactly ['checkout']. */
export const SECRET_KEY_SCOPES = ['read', 'invoices:write', 'refunds:write', 'withdrawals:write', 'webhooks:write'] as const;
export const PUBLISHABLE_KEY_SCOPES = ['checkout'] as const;
export type ApiKeyScope = (typeof SECRET_KEY_SCOPES)[number] | (typeof PUBLISHABLE_KEY_SCOPES)[number];

export const ADMIN_ROLES = ['superadmin', 'operator', 'auditor'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMISSIONS = {
  'admin:read': ADMIN_ROLES,
  'audit:read': ['superadmin', 'auditor'],
  'merchants:manage': ['superadmin', 'operator'],
  'risk:manage': ['superadmin', 'operator'],
  'kill_switch:manage': ['superadmin', 'operator'],
  // Marks an underpaid / late invoice paid (charges the fee). Step-up 2FA on top.
  'invoices:resolve': ['superadmin', 'operator'],
  // Moving platform funds between the hot wallet and cold storage (M7e). Step-up 2FA; two different admins for hot -> cold.
  'treasury:manage': ['superadmin', 'operator'],
  // Approving or rejecting custodial withdrawals (M7d). Step-up 2FA on top; big ones need two different admins.
  'withdrawals:approve': ['superadmin', 'operator'],
  // Merchant fee settings and recording prepaid fee top-ups. Step-up 2FA on top.
  'fees:manage': ['superadmin', 'operator'],
  // Turning a chain or token back ON (turning it off is kill_switch:manage).
  'registry:enable': ['superadmin'],
  'admins:manage': ['superadmin'],
} as const satisfies Record<string, readonly AdminRole[]>;

export type AdminPermission = keyof typeof ADMIN_PERMISSIONS;

export function adminCan(role: AdminRole, permission: AdminPermission): boolean {
  return (ADMIN_PERMISSIONS[permission] as readonly AdminRole[]).includes(role);
}
