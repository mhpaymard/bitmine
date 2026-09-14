-- Multiple network endpoints can belong to one public-pool account.  Shares
-- and deposits must be reconciled by that account, not by the endpoint that
-- happened to carry a connection.
ALTER TABLE "Upstream" ADD COLUMN "accountKey" VARCHAR(120);
UPDATE "Upstream" SET "accountKey" = "id"::text WHERE "accountKey" IS NULL;
ALTER TABLE "Upstream" ALTER COLUMN "accountKey" SET NOT NULL;

CREATE INDEX "Upstream_asset_accountKey_enabled_idx"
  ON "Upstream"("asset", "accountKey", "enabled");
CREATE UNIQUE INDEX "Upstream_asset_accountKey_host_port_tls_key"
  ON "Upstream"("asset", "accountKey", "host", "port", "tls");
