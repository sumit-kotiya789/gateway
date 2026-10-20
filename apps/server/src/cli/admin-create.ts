// Bootstrap an admin: `pnpm admin:create <email> <superadmin|operator|auditor>`.
// Prints the generated password and TOTP enrollment URI exactly once, to stdout of the operator's terminal.
import { randomBytes } from 'node:crypto';
import { ADMIN_ROLES, uuidv7, type AdminRole } from '@gw/core';
import { audit } from '../common/audit.js';
import { loadConfig } from '../common/config.js';
import { Envelope, LocalKek } from '../common/crypto/envelope.js';
import { hashPassword } from '../common/crypto/password.js';
import { generateTotpSecret, totpUri } from '../common/crypto/totp.js';
import { createDb, withSystem } from '../common/db.js';
import { adminUsers } from '../db/schema.js';
import { adminTotpAad } from '../modules/auth/admin-auth.routes.js';

async function main(): Promise<void> {
  const [email, role] = process.argv.slice(2);
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email) || !ADMIN_ROLES.includes(role as AdminRole)) {
    throw new Error(`usage: admin:create <email> <${ADMIN_ROLES.join('|')}>`);
  }
  const config = loadConfig();
  const envelope = new Envelope([new LocalKek(config.DATA_KEK_ID, Buffer.from(config.DATA_KEK, 'base64'))]);
  const { db, pool } = createDb(config.DATABASE_URL);
  const password = randomBytes(18).toString('base64url');
  const secret = generateTotpSecret();
  const id = uuidv7();
  try {
    await withSystem(db, async (tx) => {
      await tx.insert(adminUsers).values({
        id,
        email: email.toLowerCase(),
        passwordHash: await hashPassword(password),
        role: role as AdminRole,
        totpSecretEnc: await envelope.seal(secret, adminTotpAad(id)),
      });
      await audit(tx, { actorType: 'system', action: 'admin.created', targetType: 'admin_user', targetId: id, after: { email, role } });
    });
  } finally {
    await pool.end();
  }
  process.stdout.write(`admin created: ${email} (${role})\npassword: ${password}\ntotp: ${totpUri(secret, email, 'Gateway Admin')}\n`);
  process.stdout.write('Store the password in a password manager and enroll the TOTP URI now. Neither is shown again.\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
