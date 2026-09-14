import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { validateEnvironment } from '../config/environment';

for (const environmentFile of [
  resolve(process.cwd(), '../../.env'),
  resolve(process.cwd(), '.env'),
]) {
  if (existsSync(environmentFile)) loadEnvFile(environmentFile);
}

validateEnvironment({ ...process.env, NODE_ENV: 'production' });
process.stdout.write('Production environment validation passed.\n');
