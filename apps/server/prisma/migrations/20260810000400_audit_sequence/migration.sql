-- A monotonic audit sequence makes the tamper-evident chain deterministic even
-- when multiple events share the same millisecond timestamp.
ALTER TABLE "AuditEvent" ADD COLUMN "sequence" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "AuditEvent_sequence_key" ON "AuditEvent"("sequence");
