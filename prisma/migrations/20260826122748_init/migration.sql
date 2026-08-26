-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('FILE_IMPORT', 'TALLY_SYNC');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('ANALYZING', 'AWAITING_CONFIRMATION', 'IMPORTING', 'COMPLETED', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ANALYST', 'VIEWER');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "tallyCompanyName" TEXT,
    "tallyGuid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "centres" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "centres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "centreId" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streams" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "groupHead" TEXT NOT NULL DEFAULT 'Unclassified',
    "groupMapped" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "periods" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "quarter" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "sortKey" INTEGER NOT NULL,
    "sourceQuarter" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fact_entries" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "centreId" TEXT,
    "accountId" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "source" "DataSource" NOT NULL,
    "importId" TEXT,
    "importRowId" TEXT,
    "syncRunId" TEXT,
    "voucherDate" TIMESTAMP(3),
    "voucherType" TEXT,
    "voucherNumber" TEXT,
    "ledgerName" TEXT,
    "party" TEXT,
    "narration" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fact_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_row_summaries" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "importRowId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "totalIncome" DECIMAL(18,4) NOT NULL,
    "totalExpense" DECIMAL(18,4) NOT NULL,
    "profit" DECIMAL(18,4) NOT NULL,
    "totalRevenue" DECIMAL(18,4),
    "indirectExpenses" DECIMAL(18,4),

    CONSTRAINT "source_row_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imports" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileHash" TEXT NOT NULL,
    "mimeType" TEXT,
    "sourceType" "DataSource" NOT NULL DEFAULT 'FILE_IMPORT',
    "status" "ImportStatus" NOT NULL DEFAULT 'ANALYZING',
    "analysis" JSONB,
    "appliedMapping" JSONB,
    "mappingProfileId" TEXT,
    "mappingVersion" INTEGER,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "factCount" INTEGER NOT NULL DEFAULT 0,
    "validationStatus" TEXT,
    "validation" JSONB,
    "errorMessage" TEXT,
    "uploadedById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_files" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storagePath" TEXT,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_sheets" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sheetIndex" INTEGER NOT NULL,
    "headerRow" INTEGER,
    "dataStartRow" INTEGER,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "columnCount" INTEGER NOT NULL DEFAULT 0,
    "role" TEXT NOT NULL,
    "roleReason" TEXT,
    "headers" JSONB,

    CONSTRAINT "import_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "isTotalRow" BOOLEAN NOT NULL DEFAULT false,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "skipReason" TEXT,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapping_profiles" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "signature" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mapping_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapping_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "sourceValue" TEXT NOT NULL,
    "targetValue" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mapping_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "recordsProcessed" INTEGER NOT NULL DEFAULT 0,
    "recordsAdded" INTEGER NOT NULL DEFAULT 0,
    "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
    "recordsFailed" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "details" JSONB,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_errors" (
    "id" TEXT NOT NULL,
    "syncRunId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_errors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tally_connections" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "adapter" TEXT NOT NULL DEFAULT 'TALLY_XML_HTTP',
    "host" TEXT NOT NULL DEFAULT 'localhost',
    "port" INTEGER NOT NULL DEFAULT 9000,
    "useHttps" BOOLEAN NOT NULL DEFAULT false,
    "tallyCompanyName" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 60000,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "detectedVersion" TEXT,
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tally_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "companies_organizationId_name_key" ON "companies"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "centres_companyId_name_key" ON "centres"("companyId", "name");

-- CreateIndex
CREATE INDEX "branches_companyId_centreId_idx" ON "branches"("companyId", "centreId");

-- CreateIndex
CREATE UNIQUE INDEX "branches_companyId_abbreviation_key" ON "branches"("companyId", "abbreviation");

-- CreateIndex
CREATE UNIQUE INDEX "streams_companyId_name_key" ON "streams"("companyId", "name");

-- CreateIndex
CREATE INDEX "accounts_companyId_kind_idx" ON "accounts"("companyId", "kind");

-- CreateIndex
CREATE INDEX "accounts_companyId_groupHead_idx" ON "accounts"("companyId", "groupHead");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_companyId_normalized_key" ON "accounts"("companyId", "normalized");

-- CreateIndex
CREATE INDEX "periods_companyId_financialYear_idx" ON "periods"("companyId", "financialYear");

-- CreateIndex
CREATE INDEX "periods_companyId_sortKey_idx" ON "periods"("companyId", "sortKey");

-- CreateIndex
CREATE UNIQUE INDEX "periods_companyId_year_month_key" ON "periods"("companyId", "year", "month");

-- CreateIndex
CREATE INDEX "fact_entries_companyId_periodId_idx" ON "fact_entries"("companyId", "periodId");

-- CreateIndex
CREATE INDEX "fact_entries_companyId_kind_periodId_idx" ON "fact_entries"("companyId", "kind", "periodId");

-- CreateIndex
CREATE INDEX "fact_entries_companyId_branchId_periodId_idx" ON "fact_entries"("companyId", "branchId", "periodId");

-- CreateIndex
CREATE INDEX "fact_entries_companyId_streamId_periodId_idx" ON "fact_entries"("companyId", "streamId", "periodId");

-- CreateIndex
CREATE INDEX "fact_entries_companyId_accountId_periodId_idx" ON "fact_entries"("companyId", "accountId", "periodId");

-- CreateIndex
CREATE INDEX "fact_entries_companyId_centreId_periodId_idx" ON "fact_entries"("companyId", "centreId", "periodId");

-- CreateIndex
CREATE INDEX "fact_entries_importId_idx" ON "fact_entries"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "source_row_summaries_importRowId_key" ON "source_row_summaries"("importRowId");

-- CreateIndex
CREATE INDEX "source_row_summaries_importId_idx" ON "source_row_summaries"("importId");

-- CreateIndex
CREATE INDEX "imports_companyId_startedAt_idx" ON "imports"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "imports_companyId_fileHash_idx" ON "imports"("companyId", "fileHash");

-- CreateIndex
CREATE INDEX "import_files_importId_idx" ON "import_files"("importId");

-- CreateIndex
CREATE UNIQUE INDEX "import_sheets_importId_sheetIndex_key" ON "import_sheets"("importId", "sheetIndex");

-- CreateIndex
CREATE INDEX "import_rows_importId_idx" ON "import_rows"("importId");

-- CreateIndex
CREATE INDEX "import_rows_sheetId_rowNumber_idx" ON "import_rows"("sheetId", "rowNumber");

-- CreateIndex
CREATE INDEX "mapping_profiles_companyId_signature_idx" ON "mapping_profiles"("companyId", "signature");

-- CreateIndex
CREATE UNIQUE INDEX "mapping_profiles_companyId_name_version_key" ON "mapping_profiles"("companyId", "name", "version");

-- CreateIndex
CREATE INDEX "mapping_rules_companyId_ruleType_idx" ON "mapping_rules"("companyId", "ruleType");

-- CreateIndex
CREATE UNIQUE INDEX "mapping_rules_companyId_ruleType_sourceValue_key" ON "mapping_rules"("companyId", "ruleType", "sourceValue");

-- CreateIndex
CREATE INDEX "sync_runs_companyId_startedAt_idx" ON "sync_runs"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "sync_errors_syncRunId_idx" ON "sync_errors"("syncRunId");

-- CreateIndex
CREATE UNIQUE INDEX "tally_connections_companyId_key" ON "tally_connections"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "centres" ADD CONSTRAINT "centres_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_centreId_fkey" FOREIGN KEY ("centreId") REFERENCES "centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streams" ADD CONSTRAINT "streams_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "periods" ADD CONSTRAINT "periods_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_entries" ADD CONSTRAINT "fact_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_entries" ADD CONSTRAINT "fact_entries_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_entries" ADD CONSTRAINT "fact_entries_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_entries" ADD CONSTRAINT "fact_entries_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_entries" ADD CONSTRAINT "fact_entries_centreId_fkey" FOREIGN KEY ("centreId") REFERENCES "centres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_entries" ADD CONSTRAINT "fact_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_entries" ADD CONSTRAINT "fact_entries_importId_fkey" FOREIGN KEY ("importId") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_entries" ADD CONSTRAINT "fact_entries_importRowId_fkey" FOREIGN KEY ("importRowId") REFERENCES "import_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fact_entries" ADD CONSTRAINT "fact_entries_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "sync_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_row_summaries" ADD CONSTRAINT "source_row_summaries_importId_fkey" FOREIGN KEY ("importId") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_row_summaries" ADD CONSTRAINT "source_row_summaries_importRowId_fkey" FOREIGN KEY ("importRowId") REFERENCES "import_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_mappingProfileId_fkey" FOREIGN KEY ("mappingProfileId") REFERENCES "mapping_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_importId_fkey" FOREIGN KEY ("importId") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_sheets" ADD CONSTRAINT "import_sheets_importId_fkey" FOREIGN KEY ("importId") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_importId_fkey" FOREIGN KEY ("importId") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "import_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_profiles" ADD CONSTRAINT "mapping_profiles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_errors" ADD CONSTRAINT "sync_errors_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
