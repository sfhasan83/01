import { ValidationError } from '../core/errors.ts';
import { one, type Tx } from '../core/db.ts';
import { UAE_CHART, UAE_TAX_CODES, type AccountTemplate } from './coa.ts';

/**
 * Country packs. Everything that differs by country sits here, behind one
 * shape: the chart of accounts, tax codes, the VAT return form, how tax numbers
 * and IBANs look, which e-invoice standard applies, payroll contributions and
 * the end-of-service rule. Books take the pack of their company's country when
 * they are set up; every module then asks the pack instead of assuming the UAE.
 *
 * The UAE was the first pack and Saudi Arabia is the second. Rates that a
 * government changes (GOSI contributions) are seeded into the company's own
 * settings so they can be corrected without a new release.
 */

export type EndReason = 'contract_end' | 'termination' | 'resignation' | 'retirement' | 'death' | 'mutual';
export interface TaxCodeTemplate {
  code: string; name: string; category: 'standard' | 'zero' | 'exempt' | 'out_of_scope' | 'reverse_charge'; rate: number;
  einvoice: string | null; exemptionCode?: string; exemptionReason?: string;
}
export interface ContributionTemplate {
  code: string; name: string; appliesTo: 'nationals' | 'non_nationals' | 'all'; employeePct: number; employerPct: number;
  base: 'basic' | 'basic_housing' | 'gross'; monthlyCap: number | null;
}
export interface CountryPack {
  country: string; name: string; currency: string;
  taxAuthority: string; vatForm: string; vatFormName: string;
  chart: AccountTemplate[]; taxCodes: TaxCodeTemplate[];
  taxNumber: { test: (s: string) => boolean; message: string };
  iban: { re: RegExp; message: string };
  defaults: { corporateTaxRate: number; corporateTaxThreshold: number };
  /** Why the corporate tax provision is not available for this country, or null when it is. */
  corporateTaxGap: string | null;
  einvoice: 'pint_ae' | 'zatca';
  /** The UAE wage protection system file is produced when salaries are paid. */
  wps: boolean;
  contributions: ContributionTemplate[];
  endOfServiceRule: string;
  /** End-of-service benefit at a date. Without a reason it is the full entitlement, which is what the provision holds. */
  endOfService: (pay: { basic: number; housing: number }, joined: string, at: string, reason?: EndReason | null) => number;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * UAE gratuity (BAATS eosb()): 21 days' basic per year for the first 5 years, 30
 * days after, none before 1 year, capped at 24 months' basic; daily wage = basic / 30.
 * Since the 2022 labour law a resignation does not reduce it.
 */
export function uaeGratuity(basic: number, joined: string, at: string): number {
  if (at <= joined) return 0;
  const years = daysBetween(joined, at) / 365.25;
  if (years < 1) return 0;
  const dayCount = Math.min(years, 5) * 21 + Math.max(0, years - 5) * 30;
  return r2(Math.min(dayCount * basic / 30, basic * 24));
}

/**
 * Saudi end-of-service award (Labor Law articles 84 and 85): half a month's wage
 * for each of the first five years and a full month's wage for each year after,
 * parts of a year in proportion. The wage is basic plus housing. On resignation
 * the award is nothing under two years, a third from two to five years, two
 * thirds from five to ten, and the full award from ten years.
 */
export function saudiEndOfService(pay: { basic: number; housing: number }, joined: string, at: string, reason?: EndReason | null): number {
  if (at <= joined) return 0;
  const years = daysBetween(joined, at) / 365.25;
  const wage = pay.basic + pay.housing;
  const full = Math.min(years, 5) * wage / 2 + Math.max(0, years - 5) * wage;
  const share = reason === 'resignation' ? (years < 2 ? 0 : years < 5 ? 1 / 3 : years < 10 ? 2 / 3 : 1) : 1;
  return r2(full * share);
}

const UAE: CountryPack = {
  country: 'AE', name: 'United Arab Emirates', currency: 'AED', taxAuthority: 'FTA', vatForm: 'AE-VAT201', vatFormName: 'FTA VAT return (VAT 201)',
  chart: UAE_CHART,
  taxCodes: UAE_TAX_CODES.map((t) => ({ ...t })),
  taxNumber: { test: (s) => /^\d{15}$/.test(s), message: 'a UAE TRN has 15 digits' },
  iban: { re: /^AE\d{21}$/, message: 'a UAE IBAN is AE followed by 21 digits' },
  defaults: { corporateTaxRate: 9, corporateTaxThreshold: 375000 },
  corporateTaxGap: null,
  einvoice: 'pint_ae',
  wps: true,
  contributions: [],
  endOfServiceRule: '21 days of basic pay a year for the first five years, 30 days after; none under one year; at most 24 months',
  endOfService: (pay, joined, at) => uaeGratuity(pay.basic, joined, at),
};

/** The Saudi chart: the BAATS chart with Saudi names where they differ (VAT to ZATCA, zakat, GOSI). */
const SA_NAMES: Record<string, string> = {
  '2110': 'VAT Settlement Payable to ZATCA',
  '2400': 'Zakat and Income Tax Payable',
  '5950': 'Zakat and Income Tax Expense',
  '5400': 'Government Fees (Muqeem, Qiwa, licences)',
  '2220': 'GOSI Contributions Payable',
  '5930': 'GOSI Employer Contributions',
};
export const SAUDI_CHART: AccountTemplate[] = UAE_CHART.map((a) => (SA_NAMES[a.code] ? { ...a, name: SA_NAMES[a.code] } : a));

/**
 * Saudi VAT codes. ZATCA needs an exemption reason (VATEX code) on every
 * zero-rated, exempt or out-of-scope line; the common ones are set here and
 * more can be added as tax codes.
 */
export const SAUDI_TAX_CODES: TaxCodeTemplate[] = [
  { code: 'SR', name: 'Standard rated 15%', category: 'standard', rate: 15, einvoice: 'S' },
  { code: 'ZR', name: 'Zero rated: export of goods', category: 'zero', rate: 0, einvoice: 'Z', exemptionCode: 'VATEX-SA-32', exemptionReason: 'Export of goods' },
  { code: 'ZS', name: 'Zero rated: export of services', category: 'zero', rate: 0, einvoice: 'Z', exemptionCode: 'VATEX-SA-33', exemptionReason: 'Export of services' },
  { code: 'EX', name: 'Exempt: financial services', category: 'exempt', rate: 0, einvoice: 'E', exemptionCode: 'VATEX-SA-29',
    exemptionReason: 'Financial services mentioned in Article 29 of the VAT Regulations' },
  { code: 'OS', name: 'Out of scope', category: 'out_of_scope', rate: 0, einvoice: 'O', exemptionCode: 'VATEX-SA-OOS', exemptionReason: 'Not subject to VAT' },
  { code: 'RC', name: 'Reverse charge 15% (imported services)', category: 'reverse_charge', rate: 15, einvoice: null },
];

/**
 * GOSI as published for the private sector: Saudi employees pay 9% annuities and
 * 0.75% SANED, the employer pays the same plus 2% occupational hazards; for
 * non-Saudi employees the employer pays the 2% only. The base is basic plus
 * housing, at most SAR 45,000 a month. Employees who first joined GOSI from
 * July 2024 have annuity rates that step up each year, so these are seeded
 * into each company's settings to be checked and changed there.
 */
export const SAUDI_CONTRIBUTIONS: ContributionTemplate[] = [
  { code: 'GOSI_ANNUITY', name: 'GOSI annuities (pension)', appliesTo: 'nationals', employeePct: 9, employerPct: 9, base: 'basic_housing', monthlyCap: 45000 },
  { code: 'GOSI_SANED', name: 'SANED unemployment insurance', appliesTo: 'nationals', employeePct: 0.75, employerPct: 0.75, base: 'basic_housing', monthlyCap: 45000 },
  { code: 'GOSI_HAZARDS', name: 'Occupational hazards', appliesTo: 'all', employeePct: 0, employerPct: 2, base: 'basic_housing', monthlyCap: 45000 },
];

const SAUDI: CountryPack = {
  country: 'SA', name: 'Saudi Arabia', currency: 'SAR', taxAuthority: 'ZATCA', vatForm: 'SA-VAT', vatFormName: 'ZATCA VAT return',
  chart: SAUDI_CHART,
  taxCodes: SAUDI_TAX_CODES,
  taxNumber: { test: (s) => /^3\d{13}3$/.test(s), message: 'a Saudi VAT number has 15 digits and starts and ends with 3' },
  iban: { re: /^SA\d{22}$/, message: 'a Saudi IBAN is SA followed by 22 digits' },
  defaults: { corporateTaxRate: 0, corporateTaxThreshold: 0 },
  corporateTaxGap: 'zakat and income tax for Saudi Arabia are not covered yet; post the provision as a manual journal to 5950 and 2400',
  einvoice: 'zatca',
  wps: false,
  contributions: SAUDI_CONTRIBUTIONS,
  endOfServiceRule: 'half a month of basic plus housing a year for the first five years, a full month after; reduced on resignation (none under 2 years, a third to 5, two thirds to 10)',
  endOfService: saudiEndOfService,
};

export const PACKS: Record<string, CountryPack> = { AE: UAE, SA: SAUDI };

export function packFor(country: string): CountryPack {
  const p = PACKS[country];
  if (!p) throw new ValidationError(`the ${country} localisation pack is not available yet; the packs are ${Object.keys(PACKS).join(', ')}`);
  return p;
}

export async function companyPack(tx: Tx, companyId: string): Promise<CountryPack> {
  const c = await one(tx, 'SELECT country_code FROM fin.companies WHERE unit_id = $1', [companyId]);
  if (!c) throw new ValidationError('this company has no books yet');
  return packFor(c.country_code);
}

/** What the console shows about the packs. */
export const packSummary = () => Object.values(PACKS).map((p) => ({
  country: p.country, name: p.name, currency: p.currency, taxAuthority: p.taxAuthority, vatForm: p.vatFormName,
  einvoice: p.einvoice === 'zatca' ? 'ZATCA (Fatoora) UBL 2.1 with QR code and hash chain' : 'PINT AE (Peppol) UBL 2.1',
  taxCodes: p.taxCodes.map((t) => ({ code: t.code, name: t.name, rate: t.rate })),
  contributions: p.contributions.map((c) => ({ code: c.code, name: c.name, appliesTo: c.appliesTo, employeePct: c.employeePct, employerPct: c.employerPct, monthlyCap: c.monthlyCap })),
  endOfService: p.endOfServiceRule, payrollFile: p.wps ? 'WPS salary information file (SIF)' : null,
  corporateTax: p.corporateTaxGap ? 'not covered yet' : `${p.defaults.corporateTaxRate}% above ${p.defaults.corporateTaxThreshold.toLocaleString('en')}`,
}));
