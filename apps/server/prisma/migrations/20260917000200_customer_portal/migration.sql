CREATE TABLE "CustomerPortalCredential" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" VARCHAR(16) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CustomerPortalCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerPortalCredential_customerId_key"
ON "CustomerPortalCredential"("customerId");

CREATE INDEX "CustomerPortalCredential_customerId_revokedAt_idx"
ON "CustomerPortalCredential"("customerId", "revokedAt");

ALTER TABLE "CustomerPortalCredential"
ADD CONSTRAINT "CustomerPortalCredential_customerId_fkey"
FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
