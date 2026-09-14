import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'prisma/config';

const rootEnvironment = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnvironment)) loadEnvFile(rootEnvironment);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://mining:mining_dev_password@127.0.0.1:5432/mining_gateway?schema=public',
  },
});
