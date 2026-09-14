-- Distinguish customer distributions from operator revenue withdrawals.
CREATE TYPE "PayoutKind" AS ENUM ('CUSTOMER', 'OPERATOR');

ALTER TABLE "PayoutBatch" ADD COLUMN "kind" "PayoutKind" NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "PayoutItem" ALTER COLUMN "customerId" DROP NOT NULL;

CREATE INDEX "PayoutBatch_kind_asset_state_idx" ON "PayoutBatch"("kind", "asset", "state");
