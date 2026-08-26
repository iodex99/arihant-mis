/**
 * Tally adapter interface.
 *
 * The rest of the application talks only to this interface, never to a
 * particular Tally transport. Which adapter is correct depends on what
 * Arihant's actual Tally installation supports — see docs/tally-integration.md.
 * That is deliberately undecided in code until the POC has been run against the
 * real environment (build spec §4).
 *
 * Every operation is READ-ONLY. There is no write path, by design
 * (build spec §48, §49).
 */

export type AdapterId = 'TALLY_XML_HTTP' | 'TALLY_JSON_HTTP' | 'TALLY_ODBC';

export interface TallyConnectionConfig {
  adapter: AdapterId;
  host: string;
  port: number;
  useHttps: boolean;
  companyName?: string | null;
  timeoutMs: number;
  /** Adapter-specific extras. Never serialised to the browser. */
  extra?: Record<string, unknown>;
}

export interface ConnectionStatus {
  reachable: boolean;
  /** Version string as reported by Tally, when it reports one. */
  version?: string;
  /** Product edition, e.g. "TallyPrime". */
  product?: string;
  /** Round-trip time of the probe request. */
  latencyMs?: number;
  message: string;
  /** What to check, when unreachable. Only steps that apply to this adapter. */
  remedy?: string[];
  /** Raw diagnostic, kept for the admin page. Never contains credentials. */
  detail?: string;
}

export interface Company {
  name: string;
  guid?: string;
  startingFrom?: string;
  endingAt?: string;
}

export interface Group {
  name: string;
  parent?: string;
  /** Tally's own classification: whether the group is revenue or balance-sheet. */
  isRevenue?: boolean;
  isDeemedPositive?: boolean;
}

export interface Ledger {
  name: string;
  parent?: string;
  openingBalance?: number;
  closingBalance?: number;
  guid?: string;
}

export interface CostCentre {
  name: string;
  parent?: string;
  category?: string;
}

export interface VoucherEntry {
  ledgerName: string;
  amount: number;
  isDebit: boolean;
  costCentre?: string;
}

export interface Voucher {
  date: string;
  voucherType: string;
  voucherNumber?: string;
  party?: string;
  narration?: string;
  guid?: string;
  entries: VoucherEntry[];
}

export interface VoucherQuery {
  from: Date;
  to: Date;
  companyName?: string;
  voucherTypes?: string[];
  /** Restrict to vouchers altered since this timestamp, for incremental sync. */
  alteredSince?: Date;
}

export interface ReportQuery {
  reportName: string;
  from: Date;
  to: Date;
  companyName?: string;
  /** Adapter-specific report parameters. */
  params?: Record<string, string>;
}

/**
 * Capability probe result, shown on the connection test page (build spec §5).
 * Each capability is tested independently so a partial environment is visible
 * rather than reported as a single pass/fail.
 */
export interface CapabilityProbe {
  capability: 'companies' | 'groups' | 'ledgers' | 'costCentres' | 'vouchers' | 'reports';
  ok: boolean;
  count?: number;
  latencyMs?: number;
  message: string;
}

export interface TallyAdapter {
  readonly id: AdapterId;
  readonly label: string;

  testConnection(): Promise<ConnectionStatus>;
  getCompanies(): Promise<Company[]>;
  getGroups(companyName?: string): Promise<Group[]>;
  getLedgers(companyName?: string): Promise<Ledger[]>;
  getCostCentres(companyName?: string): Promise<CostCentre[]>;
  getVouchers(options: VoucherQuery): Promise<Voucher[]>;
  getReports(options: ReportQuery): Promise<unknown>;

  /** Run every probe, for the connection test page. */
  probeCapabilities(companyName?: string): Promise<CapabilityProbe[]>;
}

/** Raised when Tally cannot be reached or answers unusably. */
export class TallyError extends Error {
  constructor(
    message: string,
    readonly remedy: string[],
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'TallyError';
  }
}
