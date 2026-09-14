-- One-time Argon2id-hashed recovery codes for administrator two-factor authentication.
CREATE TABLE "AdminBackupCode" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "AdminBackupCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminBackupCode_adminId_usedAt_idx" ON "AdminBackupCode"("adminId", "usedAt");

ALTER TABLE "AdminBackupCode" ADD CONSTRAINT "AdminBackupCode_adminId_fkey"
FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;
