-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AssetCode" AS ENUM ('BTC', 'XMR');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PoolProtocol" AS ENUM ('BITCOIN_STRATUM_V1', 'MONERO_JSON_RPC');

-- CreateEnum
CREATE TYPE "ShareStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('OBSERVED', 'CONFIRMED', 'ALLOCATED', 'REORGED', 'IGNORED');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'CLEARING');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "JournalType" AS ENUM ('DEPOSIT', 'ALLOCATION', 'PAYOUT', 'NETWORK_FEE', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "PayoutState" AS ENUM ('PLANNED', 'APPROVAL_REQUIRED', 'AUTO_APPROVED', 'SIGNED', 'BROADCAST', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DestinationStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "Admin" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'VIEWER',
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "totpSecretCiphertext" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(48) NOT NULL,
    "displayName" VARCHAR(160) NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Tehran',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxConnections" INTEGER NOT NULL DEFAULT 1,
    "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerCredential" (
    "id" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" VARCHAR(16) NOT NULL,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SplitPolicyVersion" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "customerBps" INTEGER NOT NULL,
    "operatorBps" INTEGER NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SplitPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upstream" (
    "id" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "protocol" "PoolProtocol" NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "host" VARCHAR(255) NOT NULL,
    "port" INTEGER NOT NULL,
    "tls" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "usernameTemplate" VARCHAR(255) NOT NULL,
    "passwordCiphertext" TEXT,
    "receiveAddress" VARCHAR(256),
    "connectionTimeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "failbackCooldownSeconds" INTEGER NOT NULL DEFAULT 300,
    "lastHealthAt" TIMESTAMP(3),
    "lastHealthOk" BOOLEAN,
    "lastHealthMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Upstream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionSession" (
    "id" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "upstreamId" UUID,
    "asset" "AssetCode" NOT NULL,
    "remoteIp" VARCHAR(64) NOT NULL,
    "clientAgent" VARCHAR(255),
    "difficulty" DECIMAL(38,18) NOT NULL DEFAULT 1,
    "acceptedCount" BIGINT NOT NULL DEFAULT 0,
    "rejectedCount" BIGINT NOT NULL DEFAULT 0,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "disconnectCode" VARCHAR(80),

    CONSTRAINT "ConnectionSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareEvent" (
    "id" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "customerId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "upstreamId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "splitPolicyId" UUID NOT NULL,
    "requestKey" VARCHAR(160) NOT NULL,
    "status" "ShareStatus" NOT NULL DEFAULT 'PENDING',
    "difficulty" DECIMAL(38,18) NOT NULL,
    "normalizedWork" DECIMAL(65,18) NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "upstreamLatencyMs" INTEGER,
    "rejectReason" TEXT,
    "allocationBatchId" UUID,

    CONSTRAINT "ShareEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareAggregate" (
    "id" UUID NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "bucketSeconds" INTEGER NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "customerId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "acceptedCount" BIGINT NOT NULL DEFAULT 0,
    "rejectedCount" BIGINT NOT NULL DEFAULT 0,
    "acceptedWork" DECIMAL(65,18) NOT NULL DEFAULT 0,
    "rejectedWork" DECIMAL(65,18) NOT NULL DEFAULT 0,
    "avgLatencyMs" INTEGER,

    CONSTRAINT "ShareAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletAccount" (
    "id" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "network" VARCHAR(32) NOT NULL,
    "receiveAddress" VARCHAR(256),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastBlockRef" VARCHAR(128),
    "lastScanAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "upstreamId" UUID NOT NULL,
    "txid" VARCHAR(128) NOT NULL,
    "outputRef" VARCHAR(64) NOT NULL DEFAULT '0',
    "amountAtomic" BIGINT NOT NULL,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "locked" BOOLEAN NOT NULL DEFAULT true,
    "status" "DepositStatus" NOT NULL DEFAULT 'OBSERVED',
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "allocatedAt" TIMESTAMP(3),
    "raw" JSONB,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationBatch" (
    "id" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "upstreamId" UUID NOT NULL,
    "depositId" UUID NOT NULL,
    "totalAtomic" BIGINT NOT NULL,
    "customerTotalAtomic" BIGINT NOT NULL,
    "operatorTotalAtomic" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllocationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationItem" (
    "id" UUID NOT NULL,
    "allocationBatchId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "splitPolicyId" UUID NOT NULL,
    "work" DECIMAL(65,18) NOT NULL,
    "grossAtomic" BIGINT NOT NULL,
    "customerAtomic" BIGINT NOT NULL,
    "operatorAtomic" BIGINT NOT NULL,

    CONSTRAINT "AllocationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "customerId" UUID,
    "code" VARCHAR(120) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalTransaction" (
    "id" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "type" "JournalType" NOT NULL,
    "referenceType" VARCHAR(80) NOT NULL,
    "referenceId" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountAtomic" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutDestination" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "address" VARCHAR(256) NOT NULL,
    "status" "DestinationStatus" NOT NULL DEFAULT 'PENDING',
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "minPayoutAtomic" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PayoutDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutBatch" (
    "id" UUID NOT NULL,
    "asset" "AssetCode" NOT NULL,
    "state" "PayoutState" NOT NULL DEFAULT 'PLANNED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "totalGrossAtomic" BIGINT NOT NULL DEFAULT 0,
    "totalFeeAtomic" BIGINT NOT NULL DEFAULT 0,
    "totalNetAtomic" BIGINT NOT NULL DEFAULT 0,
    "transactionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signedPayload" TEXT,
    "approvalThresholdHit" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "broadcastAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(80),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutItem" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "destination" VARCHAR(256) NOT NULL,
    "grossAtomic" BIGINT NOT NULL,
    "allocatedFeeAtomic" BIGINT NOT NULL DEFAULT 0,
    "netAtomic" BIGINT NOT NULL,
    "journalTransactionId" UUID,

    CONSTRAINT "PayoutItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(120) NOT NULL,
    "entityType" VARCHAR(80) NOT NULL,
    "entityId" VARCHAR(128),
    "ipAddress" VARCHAR(64),
    "before" JSONB,
    "after" JSONB,
    "previousHash" VARCHAR(64),
    "eventHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "dedupeKey" VARCHAR(160) NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "title" VARCHAR(200) NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Admin_email_key" ON "Admin"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_slug_key" ON "Customer"("slug");

-- CreateIndex
CREATE INDEX "Worker_asset_status_idx" ON "Worker"("asset", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_customerId_asset_slug_key" ON "Worker"("customerId", "asset", "slug");

-- CreateIndex
CREATE INDEX "WorkerCredential_workerId_activeFrom_expiresAt_idx" ON "WorkerCredential"("workerId", "activeFrom", "expiresAt");

-- CreateIndex
CREATE INDEX "SplitPolicyVersion_customerId_asset_effectiveAt_idx" ON "SplitPolicyVersion"("customerId", "asset", "effectiveAt" DESC);

-- CreateIndex
CREATE INDEX "Upstream_asset_enabled_priority_idx" ON "Upstream"("asset", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "Upstream_asset_name_key" ON "Upstream"("asset", "name");

-- CreateIndex
CREATE INDEX "ConnectionSession_workerId_disconnectedAt_idx" ON "ConnectionSession"("workerId", "disconnectedAt");

-- CreateIndex
CREATE INDEX "ConnectionSession_asset_connectedAt_idx" ON "ConnectionSession"("asset", "connectedAt");

-- CreateIndex
CREATE INDEX "ShareEvent_upstreamId_status_allocationBatchId_submittedAt_idx" ON "ShareEvent"("upstreamId", "status", "allocationBatchId", "submittedAt");

-- CreateIndex
CREATE INDEX "ShareEvent_customerId_asset_submittedAt_idx" ON "ShareEvent"("customerId", "asset", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShareEvent_connectionId_requestKey_key" ON "ShareEvent"("connectionId", "requestKey");

-- CreateIndex
CREATE INDEX "ShareAggregate_customerId_asset_bucketStart_idx" ON "ShareAggregate"("customerId", "asset", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "ShareAggregate_bucketStart_bucketSeconds_workerId_key" ON "ShareAggregate"("bucketStart", "bucketSeconds", "workerId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletAccount_asset_label_key" ON "WalletAccount"("asset", "label");

-- CreateIndex
CREATE INDEX "Deposit_status_asset_observedAt_idx" ON "Deposit"("status", "asset", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_asset_txid_outputRef_key" ON "Deposit"("asset", "txid", "outputRef");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationBatch_depositId_key" ON "AllocationBatch"("depositId");

-- CreateIndex
CREATE INDEX "AllocationBatch_asset_createdAt_idx" ON "AllocationBatch"("asset", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AllocationItem_allocationBatchId_customerId_splitPolicyId_key" ON "AllocationItem"("allocationBatchId", "customerId", "splitPolicyId");

-- CreateIndex
CREATE INDEX "LedgerAccount_customerId_asset_idx" ON "LedgerAccount"("customerId", "asset");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_asset_code_key" ON "LedgerAccount"("asset", "code");

-- CreateIndex
CREATE INDEX "JournalTransaction_asset_occurredAt_idx" ON "JournalTransaction"("asset", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "JournalTransaction_asset_type_referenceType_referenceId_key" ON "JournalTransaction"("asset", "type", "referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "JournalEntry_accountId_createdAt_idx" ON "JournalEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "PayoutDestination_customerId_asset_status_effectiveAt_idx" ON "PayoutDestination"("customerId", "asset", "status", "effectiveAt");

-- CreateIndex
CREATE INDEX "PayoutBatch_asset_state_scheduledFor_idx" ON "PayoutBatch"("asset", "state", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutItem_batchId_customerId_key" ON "PayoutItem"("batchId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_eventHash_key" ON "AuditEvent"("eventHash");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Alert_status_severity_lastSeenAt_idx" ON "Alert"("status", "severity", "lastSeenAt" DESC);

-- CreateIndex
CREATE INDEX "Alert_dedupeKey_status_idx" ON "Alert"("dedupeKey", "status");

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerCredential" ADD CONSTRAINT "WorkerCredential_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitPolicyVersion" ADD CONSTRAINT "SplitPolicyVersion_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitPolicyVersion" ADD CONSTRAINT "SplitPolicyVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionSession" ADD CONSTRAINT "ConnectionSession_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectionSession" ADD CONSTRAINT "ConnectionSession_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ConnectionSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_splitPolicyId_fkey" FOREIGN KEY ("splitPolicyId") REFERENCES "SplitPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareEvent" ADD CONSTRAINT "ShareEvent_allocationBatchId_fkey" FOREIGN KEY ("allocationBatchId") REFERENCES "AllocationBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareAggregate" ADD CONSTRAINT "ShareAggregate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareAggregate" ADD CONSTRAINT "ShareAggregate_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationBatch" ADD CONSTRAINT "AllocationBatch_upstreamId_fkey" FOREIGN KEY ("upstreamId") REFERENCES "Upstream"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationBatch" ADD CONSTRAINT "AllocationBatch_depositId_fkey" FOREIGN KEY ("depositId") REFERENCES "Deposit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationItem" ADD CONSTRAINT "AllocationItem_allocationBatchId_fkey" FOREIGN KEY ("allocationBatchId") REFERENCES "AllocationBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationItem" ADD CONSTRAINT "AllocationItem_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllocationItem" ADD CONSTRAINT "AllocationItem_splitPolicyId_fkey" FOREIGN KEY ("splitPolicyId") REFERENCES "SplitPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "JournalTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutDestination" ADD CONSTRAINT "PayoutDestination_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutBatch" ADD CONSTRAINT "PayoutBatch_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PayoutBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutItem" ADD CONSTRAINT "PayoutItem_journalTransactionId_fkey" FOREIGN KEY ("journalTransactionId") REFERENCES "JournalTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
