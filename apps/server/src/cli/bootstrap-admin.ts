import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { hash } from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { AdminRole, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const rootEnvironment = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnvironment)) loadEnvFile(rootEnvironment);

async function main(): Promise<void> {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? process.argv[2])?.trim().toLowerCase();
  const passwordFile = process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  const password =
    process.env.BOOTSTRAP_ADMIN_PASSWORD ??
    (passwordFile ? readFileSync(passwordFile, 'utf8').trim() : process.argv[3]);
  const displayName = process.env.BOOTSTRAP_ADMIN_NAME ?? process.argv[4] ?? 'Owner';
  const databaseUrl = process.env.DATABASE_URL;
  if (!email || !password || !databaseUrl || password.length < 12) {
    throw new Error(
      'Set DATABASE_URL, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD or BOOTSTRAP_ADMIN_PASSWORD_FILE (minimum 12 characters)',
    );
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const passwordHash = await hash(password, {
      type: 2,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
    const admin = await prisma.admin.upsert({
      where: { email },
      create: { email, displayName, passwordHash, role: AdminRole.OWNER },
      update: { displayName, passwordHash, role: AdminRole.OWNER },
      select: { id: true, email: true },
    });
    process.stdout.write(`Owner ready: ${admin.email} (${admin.id})\n`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
