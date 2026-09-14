-- Convert the raw share journal to native daily range partitions. PostgreSQL
-- requires every unique key on a partitioned table to include its partition key,
-- so UUID uniqueness remains an application invariant and the database primary
-- key is (id, submittedAt).
CREATE TABLE "ShareEvent_partitioned" (
    LIKE "ShareEvent" INCLUDING DEFAULTS INCLUDING GENERATED
) PARTITION BY RANGE ("submittedAt");

ALTER TABLE "ShareEvent_partitioned"
    ADD CONSTRAINT "ShareEvent_partitioned_pkey" PRIMARY KEY ("id", "submittedAt");

DO $$
DECLARE
    start_day date;
    end_day date := current_date + 400;
    partition_day date;
    partition_name text;
BEGIN
    SELECT LEAST(COALESCE(MIN("submittedAt")::date, current_date - 1), current_date - 1)
      INTO start_day
      FROM "ShareEvent";
    partition_day := start_day;
    WHILE partition_day <= end_day LOOP
        partition_name := 'ShareEvent_p' || to_char(partition_day, 'YYYYMMDD');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF "ShareEvent_partitioned" FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            partition_day,
            partition_day + 1
        );
        partition_day := partition_day + 1;
    END LOOP;
END $$;

INSERT INTO "ShareEvent_partitioned" SELECT * FROM "ShareEvent";
DROP TABLE "ShareEvent";
ALTER TABLE "ShareEvent_partitioned" RENAME TO "ShareEvent";
ALTER TABLE "ShareEvent" RENAME CONSTRAINT "ShareEvent_partitioned_pkey" TO "ShareEvent_pkey";

CREATE INDEX "ShareEvent_id_idx" ON "ShareEvent"("id");
CREATE INDEX "ShareEvent_upstreamId_status_allocationBatchId_submittedAt_idx"
    ON "ShareEvent"("upstreamId", "status", "allocationBatchId", "submittedAt");
CREATE INDEX "ShareEvent_customerId_asset_submittedAt_idx"
    ON "ShareEvent"("customerId", "asset", "submittedAt");
CREATE UNIQUE INDEX "ShareEvent_connectionId_requestKey_submittedAt_key"
    ON "ShareEvent"("connectionId", "requestKey", "submittedAt");

ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_workerId_fkey"
    FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_upstreamId_fkey"
    FOREIGN KEY ("upstreamId") REFERENCES "Upstream"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "ConnectionSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_splitPolicyId_fkey"
    FOREIGN KEY ("splitPolicyId") REFERENCES "SplitPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_allocationBatchId_fkey"
    FOREIGN KEY ("allocationBatchId") REFERENCES "AllocationBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION ensure_share_partitions(days_ahead integer DEFAULT 60)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    offset_day integer;
    partition_day date;
    partition_name text;
BEGIN
    IF days_ahead < 1 OR days_ahead > 730 THEN
        RAISE EXCEPTION 'days_ahead must be between 1 and 730';
    END IF;
    FOR offset_day IN -1..days_ahead LOOP
        partition_day := current_date + offset_day;
        partition_name := 'ShareEvent_p' || to_char(partition_day, 'YYYYMMDD');
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF "ShareEvent" FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            partition_day,
            partition_day + 1
        );
    END LOOP;
END $$;
