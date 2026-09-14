import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('deployed PostgreSQL schema', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('uses the partition-compatible ShareEvent primary and idempotency keys', async () => {
    const primaryKey = await pool.query<{ column_name: string }>(`
      SELECT attribute.attname AS column_name
      FROM pg_constraint constraint_record
      CROSS JOIN LATERAL unnest(constraint_record.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_record.conrelid
       AND attribute.attnum = key_column.attnum
      WHERE constraint_record.conrelid = '"ShareEvent"'::regclass
        AND constraint_record.contype = 'p'
      ORDER BY key_column.ordinal
    `);
    const idempotencyIndex = await pool.query<{ indexdef: string }>(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'ShareEvent'
        AND indexname = 'ShareEvent_connectionId_requestKey_submittedAt_key'
    `);

    expect(primaryKey.rows.map((row) => row.column_name)).toEqual(['id', 'submittedAt']);
    expect(idempotencyIndex.rows[0]?.indexdef).toContain(
      'UNIQUE INDEX "ShareEvent_connectionId_requestKey_submittedAt_key"',
    );
  });

  it('has a writable partition for today and the account grouping migration', async () => {
    const partition = await pool.query<{ partition_name: string | null }>(`
      SELECT to_regclass(
        '"ShareEvent_p' || to_char(current_date, 'YYYYMMDD') || '"'
      )::text AS partition_name
    `);
    const accountColumn = await pool.query<{ is_nullable: string; data_type: string }>(`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Upstream'
        AND column_name = 'accountKey'
    `);

    expect(partition.rows[0]?.partition_name).toBeTruthy();
    expect(accountColumn.rows[0]).toEqual({ is_nullable: 'NO', data_type: 'character varying' });
  });
});
