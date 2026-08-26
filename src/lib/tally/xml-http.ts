/**
 * Tally XML/HTTP adapter.
 *
 * TallyPrime and Tally.ERP 9 can expose an HTTP listener on the machine
 * running Tally (Help → Settings → Connectivity → Client/Server configuration →
 * act as "Both" or "Server", with a port, conventionally 9000). Requests are
 * XML envelopes POSTed to that port.
 *
 * WHAT IS CONFIRMED HERE: the request/response shapes below are the documented
 * TDL "Export Data" envelope format, and this adapter is written against it.
 *
 * WHAT IS NOT CONFIRMED: whether Arihant's specific installation has the
 * listener enabled, on which host/port, which Tally version it runs, and
 * whether their licence/edition permits it. Those are environment facts that
 * can only be established by running the connection test against the real
 * machine. Nothing in this file assumes an answer — see
 * docs/tally-integration.md for exactly what is verified and what is not.
 */

import { tallyLogger } from '../logger';
import {
  TallyError,
  type CapabilityProbe,
  type Company,
  type ConnectionStatus,
  type CostCentre,
  type Group,
  type Ledger,
  type ReportQuery,
  type TallyAdapter,
  type TallyConnectionConfig,
  type Voucher,
  type VoucherEntry,
  type VoucherQuery,
} from './types';

const UNREACHABLE_REMEDY = [
  'Tally is running on the target machine and a company is open.',
  'In Tally: Help → Settings → Connectivity → Client/Server configuration, set "TallyPrime acts as" to Server (or Both) and note the port.',
  'The configured host and port match that setting.',
  'A firewall on the Tally machine allows inbound connections on that port.',
  'The MIS server can reach the Tally machine over the network.',
];

export class TallyXmlHttpAdapter implements TallyAdapter {
  readonly id = 'TALLY_XML_HTTP' as const;
  readonly label = 'Tally XML over HTTP';

  constructor(private readonly config: TallyConnectionConfig) {}

  private get endpoint(): string {
    const scheme = this.config.useHttps ? 'https' : 'http';
    return `${scheme}://${this.config.host}:${this.config.port}`;
  }

  // -------------------------------------------------------------------------

  async testConnection(): Promise<ConnectionStatus> {
    const started = Date.now();

    try {
      // The company list is the lightest request that proves Tally is
      // answering, and it needs no company to be named in advance.
      const xml = await this.post(buildCompanyListRequest());
      const latencyMs = Date.now() - started;

      const version = extract(xml, 'VERSION') ?? extract(xml, 'REMOTECMPINFO.VERSION');
      const product = extract(xml, 'PRODUCT') ?? undefined;
      const companies = parseCompanies(xml);

      return {
        reachable: true,
        version: version ?? undefined,
        product,
        latencyMs,
        message:
          companies.length > 0
            ? `Connected. ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} available.`
            : 'Connected, but Tally reported no open companies. Open the company in Tally and test again.',
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      if (error instanceof TallyError) {
        return { reachable: false, latencyMs, message: error.message, remedy: error.remedy, detail: error.detail };
      }
      const detail = error instanceof Error ? error.message : String(error);
      return {
        reachable: false,
        latencyMs,
        message: `Could not reach Tally at ${this.endpoint}.`,
        remedy: UNREACHABLE_REMEDY,
        detail,
      };
    }
  }

  async getCompanies(): Promise<Company[]> {
    return parseCompanies(await this.post(buildCompanyListRequest()));
  }

  async getGroups(companyName?: string): Promise<Group[]> {
    const xml = await this.post(
      buildCollectionRequest('Group', ['NAME', 'PARENT', 'ISREVENUE', 'ISDEEMEDPOSITIVE'], companyName ?? this.config.companyName),
    );
    return parseCollection(xml, 'GROUP').map((row) => ({
      name: row.NAME ?? row['@NAME'] ?? '',
      parent: row.PARENT,
      isRevenue: toBool(row.ISREVENUE),
      isDeemedPositive: toBool(row.ISDEEMEDPOSITIVE),
    })).filter((g) => g.name !== '');
  }

  async getLedgers(companyName?: string): Promise<Ledger[]> {
    const xml = await this.post(
      buildCollectionRequest('Ledger', ['NAME', 'PARENT', 'OPENINGBALANCE', 'CLOSINGBALANCE'], companyName ?? this.config.companyName),
    );
    return parseCollection(xml, 'LEDGER').map((row) => ({
      name: row.NAME ?? row['@NAME'] ?? '',
      parent: row.PARENT,
      openingBalance: toNumber(row.OPENINGBALANCE),
      closingBalance: toNumber(row.CLOSINGBALANCE),
    })).filter((l) => l.name !== '');
  }

  async getCostCentres(companyName?: string): Promise<CostCentre[]> {
    const xml = await this.post(
      buildCollectionRequest('Cost Centre', ['NAME', 'PARENT', 'CATEGORY'], companyName ?? this.config.companyName),
    );
    return parseCollection(xml, 'COSTCENTRE').map((row) => ({
      name: row.NAME ?? row['@NAME'] ?? '',
      parent: row.PARENT,
      category: row.CATEGORY,
    })).filter((c) => c.name !== '');
  }

  async getVouchers(options: VoucherQuery): Promise<Voucher[]> {
    const xml = await this.post(
      buildVoucherRequest(options, options.companyName ?? this.config.companyName),
    );
    return parseVouchers(xml);
  }

  async getReports(options: ReportQuery): Promise<unknown> {
    const xml = await this.post(buildReportRequest(options, options.companyName ?? this.config.companyName));
    return { raw: xml };
  }

  /**
   * Probe each capability separately, so a partly-working environment is
   * reported honestly rather than as one failure.
   */
  async probeCapabilities(companyName?: string): Promise<CapabilityProbe[]> {
    const company = companyName ?? this.config.companyName ?? undefined;

    const probes: {
      capability: CapabilityProbe['capability'];
      run: () => Promise<{ count: number }>;
    }[] = [
      { capability: 'companies', run: async () => ({ count: (await this.getCompanies()).length }) },
      { capability: 'groups', run: async () => ({ count: (await this.getGroups(company)).length }) },
      { capability: 'ledgers', run: async () => ({ count: (await this.getLedgers(company)).length }) },
      { capability: 'costCentres', run: async () => ({ count: (await this.getCostCentres(company)).length }) },
      {
        capability: 'vouchers',
        run: async () => {
          // A one-day window: enough to prove the request shape works without
          // pulling the whole book on a diagnostic.
          const to = new Date();
          const from = new Date(to.getTime() - 86_400_000);
          return { count: (await this.getVouchers({ from, to, companyName: company })).length };
        },
      },
      {
        capability: 'reports',
        run: async () => {
          const to = new Date();
          const from = new Date(to.getFullYear(), to.getMonth(), 1);
          await this.getReports({ reportName: 'Trial Balance', from, to, companyName: company });
          return { count: 1 };
        },
      },
    ];

    const results: CapabilityProbe[] = [];
    for (const probe of probes) {
      const started = Date.now();
      try {
        const { count } = await probe.run();
        results.push({
          capability: probe.capability,
          ok: true,
          count,
          latencyMs: Date.now() - started,
          message: `${count} returned`,
        });
      } catch (error) {
        results.push({
          capability: probe.capability,
          ok: false,
          latencyMs: Date.now() - started,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------

  private async post(body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    const started = Date.now();
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/xml; charset=utf-16' },
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      tallyLogger.debug({ status: response.status, ms: Date.now() - started, bytes: text.length }, 'tally request');

      if (!response.ok) {
        throw new TallyError(
          `Tally responded with HTTP ${response.status}.`,
          ['The configured port belongs to Tally and not to another service.', ...UNREACHABLE_REMEDY],
          text.slice(0, 500),
        );
      }

      // Tally reports request-level problems inside a 200 response.
      const lineError = extract(text, 'LINEERROR');
      if (lineError) {
        throw new TallyError(
          `Tally rejected the request: ${lineError}`,
          [
            'The company name in the connection settings exactly matches the company open in Tally.',
            'The Tally version supports the requested report.',
          ],
          lineError,
        );
      }

      return text;
    } catch (error) {
      if (error instanceof TallyError) throw error;

      if (error instanceof Error && error.name === 'AbortError') {
        throw new TallyError(
          `Tally did not respond within ${Math.round(this.config.timeoutMs / 1000)} seconds.`,
          [
            'Tally is not busy with a modal dialog — an open dialog blocks the listener.',
            'The requested date range is not unusually large.',
            ...UNREACHABLE_REMEDY,
          ],
          error.message,
        );
      }

      throw new TallyError(
        `Could not reach Tally at ${this.endpoint}.`,
        UNREACHABLE_REMEDY,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Request envelopes
// ---------------------------------------------------------------------------

function envelope(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><ENVELOPE>${inner}</ENVELOPE>`;
}

function buildCompanyListRequest(): string {
  return envelope(
    `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER>` +
      `<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>` +
      `<TDL><TDLMESSAGE><COLLECTION NAME="List of Companies" ISMODIFY="No">` +
      `<TYPE>Company</TYPE><NATIVEMETHOD>NAME</NATIVEMETHOD><NATIVEMETHOD>STARTINGFROM</NATIVEMETHOD>` +
      `<NATIVEMETHOD>ENDINGAT</NATIVEMETHOD><NATIVEMETHOD>GUID</NATIVEMETHOD>` +
      `</COLLECTION></TDLMESSAGE></TDL></DESC></BODY>`,
  );
}

function buildCollectionRequest(type: string, fields: string[], companyName?: string | null): string {
  const collectionName = `MIS ${type} Collection`;
  return envelope(
    `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${escapeXml(collectionName)}</ID></HEADER>` +
      `<BODY><DESC><STATICVARIABLES>` +
      `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
      (companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : '') +
      `</STATICVARIABLES>` +
      `<TDL><TDLMESSAGE><COLLECTION NAME="${escapeXml(collectionName)}" ISMODIFY="No">` +
      `<TYPE>${escapeXml(type)}</TYPE>` +
      fields.map((f) => `<NATIVEMETHOD>${escapeXml(f)}</NATIVEMETHOD>`).join('') +
      `</COLLECTION></TDLMESSAGE></TDL></DESC></BODY>`,
  );
}

function buildVoucherRequest(options: VoucherQuery, companyName?: string | null): string {
  return envelope(
    `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Day Book</ID></HEADER>` +
      `<BODY><DESC><STATICVARIABLES>` +
      `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
      `<SVFROMDATE TYPE="Date">${tallyDate(options.from)}</SVFROMDATE>` +
      `<SVTODATE TYPE="Date">${tallyDate(options.to)}</SVTODATE>` +
      (companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : '') +
      `</STATICVARIABLES></DESC></BODY>`,
  );
}

function buildReportRequest(options: ReportQuery, companyName?: string | null): string {
  return envelope(
    `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>${escapeXml(options.reportName)}</ID></HEADER>` +
      `<BODY><DESC><STATICVARIABLES>` +
      `<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
      `<SVFROMDATE TYPE="Date">${tallyDate(options.from)}</SVFROMDATE>` +
      `<SVTODATE TYPE="Date">${tallyDate(options.to)}</SVTODATE>` +
      (companyName ? `<SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>` : '') +
      Object.entries(options.params ?? {})
        .map(([k, v]) => `<${escapeXml(k)}>${escapeXml(v)}</${escapeXml(k)}>`)
        .join('') +
      `</STATICVARIABLES></DESC></BODY>`,
  );
}

/** Tally's date literal format. */
function tallyDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  );
}

// ---------------------------------------------------------------------------
// Response parsing
//
// Tally's XML is not namespaced and is shallow enough that targeted extraction
// is more robust than a full DOM parse — its responses routinely contain
// unescaped ampersands in ledger names, which strict parsers reject outright.
// ---------------------------------------------------------------------------

function extract(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeXml(m[1].trim()) : null;
}

function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function parseCompanies(xml: string): Company[] {
  return extractAll(xml, 'COMPANY').map((block) => ({
    name: extract(block, 'NAME') ?? attr(block, 'NAME') ?? '',
    guid: extract(block, 'GUID') ?? undefined,
    startingFrom: extract(block, 'STARTINGFROM') ?? undefined,
    endingAt: extract(block, 'ENDINGAT') ?? undefined,
  })).filter((c) => c.name !== '');
}

function attr(block: string, name: string): string | null {
  const m = block.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m ? decodeXml(m[1]) : null;
}

function parseCollection(xml: string, tag: string): Record<string, string>[] {
  return extractAll(xml, tag).map((block) => {
    const row: Record<string, string> = {};
    const nameAttr = attr(block, 'NAME');
    if (nameAttr) row['@NAME'] = nameAttr;
    const re = /<([A-Z0-9_.]+)[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      row[m[1].toUpperCase()] = decodeXml(m[2].trim());
    }
    return row;
  });
}

function parseVouchers(xml: string): Voucher[] {
  return extractAll(xml, 'VOUCHER').map((block) => {
    const entries: VoucherEntry[] = [];

    for (const entryTag of ['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST']) {
      for (const entry of extractAll(block, escapeRegExpTag(entryTag))) {
        const ledgerName = extract(entry, 'LEDGERNAME');
        const amount = toNumber(extract(entry, 'AMOUNT'));
        if (!ledgerName || amount === undefined) continue;
        entries.push({
          ledgerName,
          amount: Math.abs(amount),
          // Tally signs debits negative in its export.
          isDebit: amount < 0,
          costCentre: extract(entry, 'COSTCENTRENAME') ?? undefined,
        });
      }
    }

    return {
      date: extract(block, 'DATE') ?? '',
      voucherType: extract(block, 'VOUCHERTYPENAME') ?? attr(block, 'VCHTYPE') ?? '',
      voucherNumber: extract(block, 'VOUCHERNUMBER') ?? undefined,
      party: extract(block, 'PARTYLEDGERNAME') ?? extract(block, 'PARTYNAME') ?? undefined,
      narration: extract(block, 'NARRATION') ?? undefined,
      guid: extract(block, 'GUID') ?? undefined,
      entries,
    };
  });
}

function escapeRegExpTag(tag: string): string {
  return tag.replace(/\./g, '\\.');
}

function toNumber(value: string | undefined | null): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function toBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return /^(yes|true|1)$/i.test(value.trim());
}
