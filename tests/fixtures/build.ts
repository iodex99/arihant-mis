/**
 * Test fixtures.
 *
 * Built in memory from a small but structurally faithful dataset — same
 * dimension shape, same subtotal relationships, same awkward edges as the real
 * workbook (a mislabelled period column, negative expense heads, an expense
 * head with no group mapping).
 *
 * The variants below deliberately break the things a naive parser relies on:
 * column order, column names, extra rows, extra columns. The figures never
 * change, so any variant that imports to a different total is a parser bug.
 */

import ExcelJS from 'exceljs';

export interface Fact {
  stream: string;
  branch: string;
  abbreviation: string;
  centre: string;
  month: string;
  quarter: string;
  status: string;
  sales: number;
  otherIncome: number;
  rent: number;
  salary: number;
  electricity: number;
  depreciation: number;
  gateway: number;
}

/** The canonical dataset every variant must reproduce. */
export const ROWS: Fact[] = [
  { stream: 'Science', branch: 'Charkop (CKP)', abbreviation: 'CKP', centre: 'WESTERN', month: "Oct'25", quarter: 'Q3', status: 'Operating',
    sales: 500000, otherIncome: 2500, rent: 80000, salary: 120000, electricity: 15000, depreciation: -40000, gateway: 500 },
  { stream: 'Science', branch: 'Charkop (CKP)', abbreviation: 'CKP', centre: 'WESTERN', month: "Nov'25", quarter: 'Q3', status: 'Operating',
    sales: 520000, otherIncome: 3000, rent: 80000, salary: 125000, electricity: 16000, depreciation: -40000, gateway: 600 },
  { stream: 'Commerce', branch: 'Ashokvan (AV)', abbreviation: 'AV', centre: 'WESTERN', month: "Oct'25", quarter: 'Q3', status: 'Operating',
    sales: 300000, otherIncome: 1200, rent: 55000, salary: 70000, electricity: 9000, depreciation: -25000, gateway: 300 },
  { stream: 'Commerce', branch: 'Ashokvan (AV)', abbreviation: 'AV', centre: 'WESTERN', month: "Nov'25", quarter: 'Q3', status: 'Operating',
    sales: 310000, otherIncome: 900, rent: 55000, salary: 72000, electricity: 9500, depreciation: -25000, gateway: 350 },
  // A cost-only branch: expense with no revenue, so it has no margin at all.
  { stream: 'Science', branch: 'Head Office (HO)', abbreviation: 'HO', centre: 'CENTRAL', month: "Oct'25", quarter: 'Q3', status: 'Operating',
    sales: 0, otherIncome: 0, rent: 40000, salary: 200000, electricity: 5000, depreciation: 0, gateway: 0 },
  // A dormant branch: entirely zero, and must survive as a reportable zero.
  { stream: 'SSC', branch: 'Virar (VR)', abbreviation: 'VR', centre: 'WESTERN', month: "Oct'25", quarter: 'Q3', status: 'Close',
    sales: 0, otherIncome: 0, rent: 0, salary: 0, electricity: 0, depreciation: 0, gateway: 0 },
];

export const EXPENSE_HEADS = ['Rent', 'Salary And Bonus', 'ELECTRICITY EXPENSES', 'DEPRECIATION', 'PAYMENT GATEWAY CHARGES'] as const;

/** Group mapping — deliberately omits PAYMENT GATEWAY CHARGES, as the real one does. */
export const GROUP_MAP: [string, string][] = [
  ['Rent', 'Rent Expense'],
  ['Salary And Bonus', 'Non Teaching Staff'],
  ['ELECTRICITY EXPENSES', 'Electricity'],
  ['DEPRECIATION', 'Unallocated Expense'],
];

export function expected() {
  const revenue = ROWS.reduce((s, r) => s + r.sales + r.otherIncome, 0);
  const expense = ROWS.reduce(
    (s, r) => s + r.rent + r.salary + r.electricity + r.depreciation + r.gateway,
    0,
  );
  return { revenue, expense, profit: revenue - expense };
}

function expensesOf(r: Fact): number {
  return r.rent + r.salary + r.electricity + r.depreciation + r.gateway;
}

function revenueOf(r: Fact): number {
  return r.sales + r.otherIncome;
}

interface SheetSpec {
  name: string;
  rows: (string | number | null)[][];
}

async function toBuffer(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const row of s.rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function groupSheet(): SheetSpec {
  return {
    name: 'Group head',
    rows: [
      [null, null, null],
      ['Expense Head', 'Group Head', 'Type'],
      ...GROUP_MAP.map(([head, group]) => [head, group, 'Expense']),
    ],
  };
}

/**
 * Version A — the baseline layout, mirroring the real workbook including its
 * mislabelled period columns (`Quater` holds months, `Month` holds quarters).
 */
export function versionA(): Promise<Buffer> {
  return toBuffer([
    {
      name: 'Main data',
      rows: [
        ['Stream', 'Branch', 'Abbreviation', 'Centre', 'Quater', 'Month', 'Status',
         'Total Income', 'Total Expense', 'Profit', 'Sales', 'Other Income', 'Total Revenue',
         'Indirect Expenses', ...EXPENSE_HEADS],
        ...ROWS.map((r) => [
          r.stream, r.branch, r.abbreviation, r.centre, r.month, r.quarter, r.status,
          revenueOf(r), expensesOf(r), revenueOf(r) - expensesOf(r),
          r.sales, r.otherIncome, revenueOf(r),
          expensesOf(r), r.rent, r.salary, r.electricity, r.depreciation, r.gateway,
        ]),
      ],
    },
    groupSheet(),
  ]);
}

/** Version B — every column reordered, nothing renamed. */
export function versionB(): Promise<Buffer> {
  return toBuffer([
    {
      name: 'Main data',
      rows: [
        ['Total Expense', 'PAYMENT GATEWAY CHARGES', 'Branch', 'DEPRECIATION', 'Profit', 'Month',
         'ELECTRICITY EXPENSES', 'Centre', 'Total Income', 'Salary And Bonus', 'Abbreviation',
         'Quater', 'Rent', 'Stream', 'Sales', 'Status', 'Other Income'],
        ...ROWS.map((r) => [
          expensesOf(r), r.gateway, r.branch, r.depreciation, revenueOf(r) - expensesOf(r), r.quarter,
          r.electricity, r.centre, revenueOf(r), r.salary, r.abbreviation,
          r.month, r.rent, r.stream, r.sales, r.status, r.otherIncome,
        ]),
      ],
    },
    groupSheet(),
  ]);
}

/** Version C — synonym column names throughout. */
export function versionC(): Promise<Buffer> {
  return toBuffer([
    {
      name: 'Financials',
      rows: [
        ['Course Stream', 'Branch Name', 'Branch Code', 'Region', 'Period', 'Qtr', 'Branch Status',
         'Revenue', 'Expenses', 'Net Profit', 'Sales', 'Other Income', 'Total Revenue',
         'Indirect Expenses', ...EXPENSE_HEADS],
        ...ROWS.map((r) => [
          r.stream, r.branch, r.abbreviation, r.centre, r.month, r.quarter, r.status,
          revenueOf(r), expensesOf(r), revenueOf(r) - expensesOf(r),
          r.sales, r.otherIncome, revenueOf(r),
          expensesOf(r), r.rent, r.salary, r.electricity, r.depreciation, r.gateway,
        ]),
      ],
    },
    groupSheet(),
  ]);
}

/**
 * Version D — title rows, blank rows, an extra unrecognised column, a grand
 * total row, and numbers written as formatted strings.
 */
export function versionD(): Promise<Buffer> {
  const total = expected();

  const money = (n: number) =>
    n < 0
      ? `(${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })})`
      : `₹ ${n.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  return toBuffer([
    {
      name: 'MIS',
      rows: [
        ['Arihant Academy', null, null, null],
        ['Monthly MIS — FY 2025-26', null, null, null],
        ['Prepared on: 26 Aug 2026', null, null, null],
        [null, null, null, null],
        ['Stream', 'Branch', 'Abbreviation', 'Centre', 'Quater', 'Month', 'Status',
         'Total Income', 'Total Expense', 'Profit', 'Sales', 'Other Income', 'Total Revenue',
         'Indirect Expenses', ...EXPENSE_HEADS, 'Remarks'],
        ...ROWS.flatMap((r, i) => {
          const row = [
            r.stream, r.branch, r.abbreviation, r.centre, r.month, r.quarter, r.status,
            money(revenueOf(r)), money(expensesOf(r)), money(revenueOf(r) - expensesOf(r)),
            money(r.sales), money(r.otherIncome), money(revenueOf(r)),
            money(expensesOf(r)), money(r.rent), money(r.salary), money(r.electricity),
            money(r.depreciation), money(r.gateway), 'reviewed',
          ];
          // A blank row partway through must not truncate the import.
          return i === 2 ? [new Array(20).fill(null), row] : [row];
        }),
        [null, null, null, null],
        ['Grand Total', null, null, null, null, null, null,
         money(total.revenue), money(total.expense), money(total.profit)],
      ],
    },
    groupSheet(),
  ]);
}

/** Version E — CSV, single sheet, no mapping sheet available. */
export function versionE(): Buffer {
  const header = [
    'Stream', 'Branch', 'Abbreviation', 'Centre', 'Quater', 'Month', 'Status',
    'Total Income', 'Total Expense', 'Profit', 'Sales', 'Other Income', 'Total Revenue',
    'Indirect Expenses', ...EXPENSE_HEADS,
  ];

  const lines = [
    header.join(','),
    ...ROWS.map((r) =>
      [
        r.stream, `"${r.branch}"`, r.abbreviation, r.centre, `"${r.month}"`, r.quarter, r.status,
        revenueOf(r), expensesOf(r), revenueOf(r) - expensesOf(r),
        r.sales, r.otherIncome, revenueOf(r),
        expensesOf(r), r.rent, r.salary, r.electricity, r.depreciation, r.gateway,
      ].join(','),
    ),
  ];

  return Buffer.from(lines.join('\n'), 'utf8');
}
