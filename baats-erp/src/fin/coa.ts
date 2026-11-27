/**
 * UAE chart of accounts template, carried over from BAATS Accounting v10.86
 * (defAcc + ensureAcc), keeping its account codes so BAATS users, reports and
 * imported books map one to one.
 *
 * Kind: G = group heading (not postable), L = ledger account.
 * role: what the posting engine looks the account up by.
 * control: receivable / payable accounts need a customer or supplier on each line.
 * manual: false = posted by documents only (control and VAT accounts), as in BAATS
 *         where customers and suppliers stay in subledgers under 1100 / 2000.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface AccountTemplate {
  code: string; name: string; type: AccountType; parent?: string; kind: 'G' | 'L';
  role?: string; control?: 'receivable' | 'payable'; manual?: boolean;
}

const G = (code: string, name: string, type: AccountType, parent?: string): AccountTemplate => ({ code, name, type, parent, kind: 'G' });
const L = (code: string, name: string, type: AccountType, parent: string, extra: Partial<AccountTemplate> = {}): AccountTemplate =>
  ({ code, name, type, parent, kind: 'L', ...extra });

export const UAE_CHART: AccountTemplate[] = [
  G('1', 'Assets', 'asset'),
  G('11', 'Current Assets', 'asset', '1'),
  L('1000', 'Cash', 'asset', '11', { role: 'cash' }),
  L('1010', 'Bank', 'asset', '11', { role: 'bank' }),
  L('1050', 'Post-Dated Cheques Received (PDC)', 'asset', '11', { role: 'pdc_received' }),
  L('1100', 'Accounts Receivable (customers control)', 'asset', '11', { role: 'receivable', control: 'receivable', manual: false }),
  L('1150', 'VAT on Customer Advances (clearing)', 'asset', '11', { role: 'vat_advance_customer', manual: false }),
  L('1200', 'Input VAT Recoverable', 'asset', '11', { role: 'vat_input', manual: false }),
  L('1210', 'Input VAT – Bills Received Late (next period)', 'asset', '11', { role: 'vat_input_deferred', manual: false }),
  L('1250', 'Prepaid Expenses', 'asset', '11', { role: 'prepaid' }),
  L('1260', 'Employee Advances & Loans', 'asset', '11', { role: 'employee_advances' }),
  L('1300', 'Inventory', 'asset', '11', { role: 'inventory' }),
  L('1350', 'Work in Progress (production)', 'asset', '11', { role: 'wip', manual: false }),
  G('12', 'Non-current Assets', 'asset', '1'),
  L('1500', 'Fixed Assets – Cost', 'asset', '12', { role: 'fixed_assets' }),
  L('1590', 'Accumulated Depreciation – Fixed Assets', 'asset', '12', { role: 'accumulated_depreciation' }),
  L('1600', 'Right-of-Use Assets (IFRS 16)', 'asset', '12', { role: 'rou_assets' }),
  L('1690', 'Accumulated Depreciation – Right-of-Use Assets', 'asset', '12', { role: 'rou_depreciation' }),

  G('2', 'Liabilities', 'liability'),
  G('21', 'Current Liabilities', 'liability', '2'),
  L('2000', 'Accounts Payable (suppliers control)', 'liability', '21', { role: 'payable', control: 'payable', manual: false }),
  L('2010', 'Goods Received Not Invoiced (GRNI)', 'liability', '21', { role: 'grni', manual: false }),
  L('2050', 'Post-Dated Cheques Issued (PDC)', 'liability', '21', { role: 'pdc_issued' }),
  L('2100', 'Output VAT Payable', 'liability', '21', { role: 'vat_output', manual: false }),
  L('2105', 'Output VAT – Declared in a Later Return', 'liability', '21', { role: 'vat_output_deferred', manual: false }),
  L('2110', 'VAT Settlement Payable to FTA', 'liability', '21', { role: 'vat_settlement' }),
  L('2160', 'VAT on Supplier Advances (clearing)', 'liability', '21', { role: 'vat_advance_supplier', manual: false }),
  L('2200', 'Accrued Expenses', 'liability', '21', { role: 'accruals' }),
  L('2210', 'Salaries Payable', 'liability', '21', { role: 'salaries_payable' }),
  L('2220', 'Pension Contributions Payable (GPSSA)', 'liability', '21', { role: 'social_insurance_payable', manual: false }),
  L('2300', 'Deferred Revenue (contract liabilities)', 'liability', '21', { role: 'deferred_revenue' }),
  L('2400', 'Corporate Tax Payable', 'liability', '21', { role: 'corporate_tax_payable' }),
  L('2500', 'End-of-Service Benefits Provision', 'liability', '21', { role: 'eosb_provision' }),
  L('2600', 'Lease Liabilities (IFRS 16)', 'liability', '21', { role: 'lease_liabilities' }),
  L('2900', 'Suspense – Unclassified Bank Items', 'liability', '21', { role: 'suspense' }),

  G('3', 'Equity', 'equity'),
  G('31', "Owner's Equity", 'equity', '3'),
  L('3000', "Owner's Capital", 'equity', '31', { role: 'capital' }),
  L('3100', 'Retained Earnings', 'equity', '31', { role: 'retained_earnings' }),
  L('3200', 'Opening Balance Equity', 'equity', '31', { role: 'opening_balance_equity' }),

  G('4', 'Revenue', 'revenue'),
  G('41', 'Operating Revenue', 'revenue', '4'),
  L('4000', 'Service Revenue', 'revenue', '41', { role: 'default_revenue' }),
  L('4100', 'Other Income', 'revenue', '41'),
  L('4200', 'Sales of Goods', 'revenue', '41'),
  L('4210', 'Sales Returns & Allowances', 'revenue', '41'),
  L('4450', 'Foreign Exchange Gain / (Loss)', 'revenue', '41', { role: 'fx_gain_loss' }),

  G('5', 'Expenses', 'expense'),
  G('51', 'Administrative Expenses', 'expense', '5'),
  L('5000', 'Salaries & Wages', 'expense', '51', { role: 'salaries' }),
  L('5100', 'Rent', 'expense', '51'),
  L('5200', 'Utilities', 'expense', '51'),
  L('5300', 'Software & Subscriptions', 'expense', '51'),
  L('5400', 'Government & License Fees', 'expense', '51'),
  L('5500', 'Office Supplies', 'expense', '51'),
  L('5600', 'Travel', 'expense', '51'),
  L('5250', 'Repairs & Maintenance', 'expense', '51', { role: 'maintenance' }),
  L('5610', 'Vehicle Fuel & Running Costs', 'expense', '51', { role: 'vehicle_running' }),
  L('5700', 'Bad Debts Written Off', 'expense', '51', { role: 'bad_debts' }),
  L('5900', 'Other Expenses', 'expense', '51', { role: 'default_expense' }),
  L('5920', 'End-of-Service Benefit Expense', 'expense', '51', { role: 'eosb_expense' }),
  L('5930', 'Employer Pension Contributions', 'expense', '51', { role: 'social_insurance_expense' }),
  G('52', 'Direct Service Costs', 'expense', '5'),
  L('5010', 'Direct Staff Costs', 'expense', '52'),
  L('5020', 'Subcontractors & Outsourced Services', 'expense', '52'),
  L('5030', 'Direct Software & Tools', 'expense', '52'),
  L('5040', 'Other Direct Costs', 'expense', '52'),
  L('5050', 'Cost of Goods Sold', 'expense', '52', { role: 'cogs' }),
  L('5070', 'Inventory Adjustments & Write-offs', 'expense', '52', { role: 'inventory_adjustments' }),
  L('5015', 'Project Labour (from timesheets)', 'expense', '52', { role: 'project_labour', manual: false }),
  L('5060', 'Production Labour & Overhead Absorbed', 'expense', '52', { role: 'production_absorbed', manual: false }),
  G('53', 'Depreciation, Finance Costs & Tax', 'expense', '5'),
  L('5800', 'Depreciation Expense', 'expense', '53', { role: 'depreciation' }),
  L('5810', 'Depreciation – Right-of-Use Assets', 'expense', '53'),
  L('5820', 'Lease Interest Expense', 'expense', '53'),
  L('5950', 'Corporate Tax Expense', 'expense', '53', { role: 'corporate_tax_expense' }),
];

/**
 * UAE VAT codes. Categories and e-invoice codes follow BAATS Accounting's
 * PINT AE mapping: S standard, Z zero-rated, E exempt, O out of scope, AE reverse charge.
 */
export const UAE_TAX_CODES = [
  { code: 'SR', name: 'Standard rated 5%', category: 'standard', rate: 5, einvoice: 'S' },
  { code: 'ZR', name: 'Zero rated', category: 'zero', rate: 0, einvoice: 'Z' },
  { code: 'EX', name: 'Exempt', category: 'exempt', rate: 0, einvoice: 'E' },
  { code: 'OS', name: 'Out of scope', category: 'out_of_scope', rate: 0, einvoice: 'O' },
  { code: 'RC', name: 'Reverse charge 5% (imported services and goods)', category: 'reverse_charge', rate: 5, einvoice: 'AE' },
] as const;
