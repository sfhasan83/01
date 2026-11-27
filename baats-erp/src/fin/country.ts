import { ValidationError } from '../core/errors.ts';
import { one, type Tx } from '../core/db.ts';
import { minorUnits, roundMoney, useBaseCurrency } from '../core/money.ts';
import { UAE_CHART, UAE_TAX_CODES, type AccountTemplate } from './coa.ts';

/**
 * Country packs. Everything that differs by country sits here, behind one
 * shape: the chart of accounts, tax codes, the VAT return form, how tax numbers
 * and IBANs look, which e-invoice standard applies, payroll contributions and
 * the end-of-service rule. Books take the pack of their company's country when
 * they are set up; every module then asks the pack instead of assuming the UAE.
 *
 * The UAE was the first pack, Saudi Arabia the second, and Oman, Bahrain, Qatar
 * and Kuwait complete the GCC. Rates that a government changes (social insurance
 * contributions) are seeded into the company's own settings so they can be
 * corrected without a new release.
 */

export type EndReason = 'contract_end' | 'termination' | 'resignation' | 'retirement' | 'death' | 'mutual';
export interface TaxCodeTemplate {
  code: string; name: string; category: 'standard' | 'zero' | 'exempt' | 'out_of_scope' | 'reverse_charge'; rate: number;
  einvoice: string | null; exemptionCode?: string; exemptionReason?: string;
}
export interface ContributionTemplate {
  code: string; name: string; appliesTo: 'nationals' | 'non_nationals' | 'all'; employeePct: number; employerPct: number;
  base: 'basic' | 'basic_housing' | 'gross'; monthlyCap: number | null;
  /** A higher employer rate from this many years of service (Bahrain's leaving indemnity). */
  afterYears?: number; employerPctAfter?: number;
}
export interface CountryPack {
  country: string; name: string; currency: string;
  taxAuthority: string;
  /** The VAT return form, or null where the country has no VAT. */
  vatForm: string | null; vatFormName: string;
  /** Why there is no VAT return, where vatForm is null. */
  noVat?: string;
  chart: AccountTemplate[]; taxCodes: TaxCodeTemplate[];
  taxNumber: { test: (s: string) => boolean; message: string };
  iban: { re: RegExp; message: string };
  defaults: { corporateTaxRate: number; corporateTaxThreshold: number };
  /** Why the corporate tax provision is not available for this country, or null when it is. */
  corporateTaxGap: string | null;
  /** The e-invoice standard, or null where none is in force yet. */
  einvoice: 'pint_ae' | 'zatca' | null;
  /** Why e-invoices are not issued, where einvoice is null. */
  einvoiceGap?: string;
  /** The UAE wage protection system file is produced when salaries are paid. */
  wps: boolean;
  /** The wage protection file this country uses that is not produced yet, if any. */
  payrollFileGap?: string;
  contributions: ContributionTemplate[];
  endOfServiceRule: string;
  /**
   * End-of-service benefit at a date. Without a reason it is the full entitlement, which is what the provision holds.
   * national: the employee is a national of the company's country (several countries pay nationals a pension instead).
   */
  endOfService: (pay: { basic: number; housing: number }, joined: string, at: string, reason?: EndReason | null, national?: boolean) => number;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

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
  return roundMoney(Math.min(dayCount * basic / 30, basic * 24));
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
  return roundMoney(full * share);
}

/**
 * Labour-law end-of-service awards of the other GCC states. Each is a number of
 * days' (or months') wage per year of service, parts of a year in proportion.
 * Nationals covered by the state pension fund are not owed it: the pension
 * replaces it in Oman, Bahrain, Qatar and Kuwait.
 */

/**
 * Oman (Labour Law, Royal Decree 53/2023): one month's basic wage for each year of
 * service, for non-Omani employees. Not reduced on resignation.
 */
export function omanEndOfService(pay: { basic: number; housing: number }, joined: string, at: string, _reason?: EndReason | null, national?: boolean): number {
  if (national || at <= joined) return 0;
  const years = daysBetween(joined, at) / 365.25;
  return roundMoney(years * pay.basic);
}

/** Service from this date is covered by the SIO leaving-indemnity contribution instead (Bahrain). */
export const BAHRAIN_INDEMNITY_FROM = '2024-03-01';

/**
 * Bahrain (Labour Law 36/2012, article 116): half a month's wage for each of the
 * first three years and a month for each year after, for non-Bahraini employees.
 * Since 1 March 2024 the employer pays this monthly to the SIO, which pays the
 * worker, so the employer owes it directly only for service before that date.
 * The wage is basic plus housing.
 */
export function bahrainEndOfService(pay: { basic: number; housing: number }, joined: string, at: string, _reason?: EndReason | null, national?: boolean): number {
  if (national) return 0;
  const end = at < BAHRAIN_INDEMNITY_FROM ? at : BAHRAIN_INDEMNITY_FROM;
  if (end <= joined) return 0;
  const years = daysBetween(joined, end) / 365.25;
  const wage = pay.basic + pay.housing;
  return roundMoney(Math.min(years, 3) * wage / 2 + Math.max(0, years - 3) * wage);
}

/**
 * Qatar (Labour Law 14/2004, article 54): at least three weeks' basic wage for each
 * year of service after the first year, for non-Qatari employees.
 */
export function qatarEndOfService(pay: { basic: number; housing: number }, joined: string, at: string, _reason?: EndReason | null, national?: boolean): number {
  if (national || at <= joined) return 0;
  const years = daysBetween(joined, at) / 365.25;
  if (years < 1) return 0;
  return roundMoney(years * 21 * pay.basic / 30);
}

/**
 * Kuwait (Labour Law 6/2010, articles 51 and 53): fifteen days' wage for each of
 * the first five years and a month for each year after, at most eighteen months'
 * wage, for non-Kuwaiti employees. On resignation: nothing under three years,
 * half from three to five, two thirds from five to ten, the full award from ten.
 * The wage is basic plus housing.
 */
export function kuwaitEndOfService(pay: { basic: number; housing: number }, joined: string, at: string, reason?: EndReason | null, national?: boolean): number {
  if (national || at <= joined) return 0;
  const years = daysBetween(joined, at) / 365.25;
  const wage = pay.basic + pay.housing;
  const full = Math.min(Math.min(years, 5) * wage / 2 + Math.max(0, years - 5) * wage, wage * 18);
  const share = reason === 'resignation' ? (years < 3 ? 0 : years < 5 ? 1 / 2 : years < 10 ? 2 / 3 : 1) : 1;
  return roundMoney(full * share);
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

/** A chart from the BAATS chart with the country's own names where they differ. */
const chartWith = (names: Record<string, string>): AccountTemplate[] => UAE_CHART.map((a) => (names[a.code] ? { ...a, name: names[a.code] } : a));

/** VAT codes shared by the GCC VAT countries; rates and exemption examples differ. */
const gccVatCodes = (rate: number, zeroDomestic: string, exempt: string): TaxCodeTemplate[] => [
  { code: 'SR', name: `Standard rated ${rate}%`, category: 'standard', rate, einvoice: 'S' },
  { code: 'ZD', name: `Zero rated: ${zeroDomestic}`, category: 'zero', rate: 0, einvoice: 'Z' },
  { code: 'ZR', name: 'Zero rated: exports of goods and services', category: 'zero', rate: 0, einvoice: 'Z' },
  { code: 'EX', name: `Exempt: ${exempt}`, category: 'exempt', rate: 0, einvoice: 'E' },
  { code: 'OS', name: 'Out of scope', category: 'out_of_scope', rate: 0, einvoice: 'O' },
  { code: 'RC', name: `Reverse charge ${rate}% (imported services)`, category: 'reverse_charge', rate, einvoice: null },
];
/** Countries without VAT still put a code on every invoice line. */
const NO_VAT_CODES = (country: string): TaxCodeTemplate[] => [
  { code: 'NV', name: `No VAT (${country} has no VAT)`, category: 'out_of_scope', rate: 0, einvoice: 'O' },
];

/**
 * Oman: 5% VAT since April 2021 (Tax Authority); 15% corporate income tax. Social
 * protection (Royal Decree 52/2023) for Omani employees: pension 7% employee and
 * 11.5% employer, job security 1% each, sick and maternity leave 1% employer; work
 * injury 1% employer for everyone; on gross pay up to OMR 3,000 a month.
 */
const OMAN: CountryPack = {
  country: 'OM', name: 'Oman', currency: 'OMR', taxAuthority: 'Oman Tax Authority', vatForm: 'OM-VAT', vatFormName: 'Oman VAT return',
  chart: chartWith({ '2110': 'VAT Payable to the Tax Authority', '2400': 'Income Tax Payable', '5950': 'Income Tax Expense',
    '2220': 'Social Protection Fund Contributions Payable', '5930': 'Social Protection Employer Contributions' }),
  taxCodes: gccVatCodes(5, 'basic foodstuffs, medicines and healthcare', 'financial services and residential property'),
  taxNumber: { test: (s) => /^OM\d{10}$/.test(s), message: 'an Oman VAT number is OM followed by 10 digits' },
  iban: { re: /^OM\d{5}[A-Z0-9]{16}$/, message: 'an Oman IBAN is OM, 2 check digits, a 3-digit bank code and 16 characters' },
  defaults: { corporateTaxRate: 15, corporateTaxThreshold: 0 },
  corporateTaxGap: null,
  einvoice: null,
  einvoiceGap: 'Oman\'s e-invoicing (Fawtara) is not in force yet; invoices are printed or sent as PDF',
  wps: false,
  payrollFileGap: 'the Oman WPS salary file is not produced yet; upload salaries through your bank',
  contributions: [
    { code: 'SPF_PENSION', name: 'Pension (old age, disability and death)', appliesTo: 'nationals', employeePct: 7, employerPct: 11.5, base: 'gross', monthlyCap: 3000 },
    { code: 'SPF_JOB_SECURITY', name: 'Job security', appliesTo: 'nationals', employeePct: 1, employerPct: 1, base: 'gross', monthlyCap: 3000 },
    { code: 'SPF_SICK_MATERNITY', name: 'Sick and maternity leave', appliesTo: 'nationals', employeePct: 0, employerPct: 1, base: 'gross', monthlyCap: 3000 },
    { code: 'SPF_INJURY', name: 'Work injuries and occupational diseases', appliesTo: 'all', employeePct: 0, employerPct: 1, base: 'gross', monthlyCap: 3000 },
  ],
  endOfServiceRule: 'non-Omanis: one month of basic pay a year of service; Omanis are covered by the Social Protection Fund',
  endOfService: omanEndOfService,
};

/**
 * Bahrain: 10% VAT since January 2022 (National Bureau for Revenue); no general
 * corporate income tax. SIO for Bahraini employees: pension 7% employee and 12%
 * employer, unemployment 1% each; for everyone work injury 3% employer; for
 * non-Bahrainis unemployment 1% each and the leaving indemnity (4.2% of wages,
 * 8.4% after three years' service) paid by the employer since March 2024; on
 * wages up to BHD 4,000 a month.
 */
const BAHRAIN: CountryPack = {
  country: 'BH', name: 'Bahrain', currency: 'BHD', taxAuthority: 'NBR', vatForm: 'BH-VAT', vatFormName: 'NBR VAT return',
  chart: chartWith({ '2110': 'VAT Payable to the NBR', '2400': 'Tax Payable', '5950': 'Tax Expense',
    '2220': 'SIO Contributions Payable', '5930': 'SIO Employer Contributions' }),
  taxCodes: gccVatCodes(10, 'basic foodstuffs, healthcare and education', 'financial services and residential property'),
  taxNumber: { test: (s) => /^\d{15}$/.test(s), message: 'a Bahrain VAT account number has 15 digits' },
  iban: { re: /^BH\d{2}[A-Z]{4}[A-Z0-9]{14}$/, message: 'a Bahrain IBAN is BH, 2 check digits, a 4-letter bank code and 14 characters' },
  defaults: { corporateTaxRate: 0, corporateTaxThreshold: 0 },
  corporateTaxGap: 'Bahrain has no general corporate income tax; the domestic minimum top-up tax for large multinational groups is not covered',
  einvoice: null,
  einvoiceGap: 'Bahrain has no e-invoicing mandate; invoices are printed or sent as PDF',
  wps: false,
  payrollFileGap: 'the Bahrain WPS salary file is not produced yet; upload salaries through your bank',
  contributions: [
    { code: 'SIO_PENSION', name: 'Pension (old age, disability and death)', appliesTo: 'nationals', employeePct: 7, employerPct: 12, base: 'gross', monthlyCap: 4000 },
    { code: 'SIO_UNEMPLOYMENT', name: 'Unemployment insurance', appliesTo: 'all', employeePct: 1, employerPct: 1, base: 'gross', monthlyCap: 4000 },
    { code: 'SIO_INJURY', name: 'Employment injuries', appliesTo: 'all', employeePct: 0, employerPct: 3, base: 'gross', monthlyCap: 4000 },
    { code: 'SIO_INDEMNITY', name: 'Leaving indemnity (end of service)', appliesTo: 'non_nationals', employeePct: 0, employerPct: 4.2, base: 'basic_housing',
      monthlyCap: null, afterYears: 3, employerPctAfter: 8.4 },
  ],
  endOfServiceRule: 'non-Bahrainis: half a month of basic plus housing a year for the first three years and a month after, for service before March 2024 (since then the SIO leaving indemnity is paid monthly); Bahrainis are covered by the SIO pension',
  endOfService: bahrainEndOfService,
};

/**
 * Qatar: no VAT; corporate income tax of 10% applies to the foreign-owned share of
 * profits. GRSIA for Qatari employees: pension 7% employee and 14% employer.
 */
const QATAR: CountryPack = {
  country: 'QA', name: 'Qatar', currency: 'QAR', taxAuthority: 'GTA', vatForm: null, vatFormName: 'No VAT return',
  noVat: 'Qatar has no VAT, so there is no VAT return',
  chart: chartWith({ '2110': 'Tax Settlement Payable to the GTA', '2400': 'Income Tax Payable', '5950': 'Income Tax Expense',
    '2220': 'GRSIA Pension Contributions Payable', '5930': 'GRSIA Employer Pension Contributions' }),
  taxCodes: NO_VAT_CODES('Qatar'),
  taxNumber: { test: (s) => /^\d{10}$/.test(s), message: 'a Qatar tax identification number has 10 digits' },
  iban: { re: /^QA\d{2}[A-Z]{4}[A-Z0-9]{21}$/, message: 'a Qatar IBAN is QA, 2 check digits, a 4-letter bank code and 21 characters' },
  defaults: { corporateTaxRate: 0, corporateTaxThreshold: 0 },
  corporateTaxGap: 'Qatar income tax (10% of the foreign-owned share of profits) is not covered yet; post the provision as a manual journal to 5950 and 2400',
  einvoice: null,
  einvoiceGap: 'Qatar has no e-invoicing mandate; invoices are printed or sent as PDF',
  wps: false,
  payrollFileGap: 'the Qatar WPS salary file is not produced yet; upload salaries through your bank',
  contributions: [
    { code: 'GRSIA_PENSION', name: 'Pension (GRSIA)', appliesTo: 'nationals', employeePct: 7, employerPct: 14, base: 'basic_housing', monthlyCap: 100000 },
  ],
  endOfServiceRule: 'non-Qataris: three weeks of basic pay a year of service, after the first year; Qataris are covered by the GRSIA pension',
  endOfService: qatarEndOfService,
};

/**
 * Kuwait: no VAT; income tax of 15% applies to foreign companies, and zakat and the
 * national labour support tax to listed Kuwaiti companies. PIFSS for Kuwaiti
 * employees: about 10.5% employee and 11.5% employer on wages up to KWD 2,750.
 */
const KUWAIT: CountryPack = {
  country: 'KW', name: 'Kuwait', currency: 'KWD', taxAuthority: 'Ministry of Finance', vatForm: null, vatFormName: 'No VAT return',
  noVat: 'Kuwait has no VAT, so there is no VAT return',
  chart: chartWith({ '2110': 'Tax Settlement Payable', '2400': 'Income Tax, Zakat and NLST Payable', '5950': 'Income Tax, Zakat and NLST Expense',
    '2220': 'PIFSS Contributions Payable', '5930': 'PIFSS Employer Contributions' }),
  taxCodes: NO_VAT_CODES('Kuwait'),
  taxNumber: { test: (s) => /^[A-Z0-9-]{4,20}$/i.test(s), message: 'enter the tax card number as letters, digits and dashes' },
  iban: { re: /^KW\d{2}[A-Z]{4}[A-Z0-9]{22}$/, message: 'a Kuwait IBAN is KW, 2 check digits, a 4-letter bank code and 22 characters' },
  defaults: { corporateTaxRate: 0, corporateTaxThreshold: 0 },
  corporateTaxGap: 'Kuwait income tax, zakat and the national labour support tax are not covered yet; post the provision as a manual journal to 5950 and 2400',
  einvoice: null,
  einvoiceGap: 'Kuwait has no e-invoicing mandate; invoices are printed or sent as PDF',
  wps: false,
  payrollFileGap: 'the Kuwait WPS salary file is not produced yet; upload salaries through your bank',
  contributions: [
    { code: 'PIFSS', name: 'Social security (PIFSS)', appliesTo: 'nationals', employeePct: 10.5, employerPct: 11.5, base: 'gross', monthlyCap: 2750 },
  ],
  endOfServiceRule: 'non-Kuwaitis: fifteen days of basic plus housing a year for the first five years and a month after, at most 18 months; reduced on resignation (none under 3 years, half to 5, two thirds to 10); Kuwaitis are covered by PIFSS',
  endOfService: kuwaitEndOfService,
};

export const PACKS: Record<string, CountryPack> = { AE: UAE, SA: SAUDI, OM: OMAN, BH: BAHRAIN, QA: QATAR, KW: KUWAIT };

export function packFor(country: string): CountryPack {
  const p = PACKS[country];
  if (!p) throw new ValidationError(`the ${country} localisation pack is not available yet; the packs are ${Object.keys(PACKS).join(', ')}`);
  return p;
}

export async function companyPack(tx: Tx, companyId: string): Promise<CountryPack> {
  const c = await one(tx, 'SELECT country_code, base_currency FROM fin.companies WHERE unit_id = $1', [companyId]);
  if (!c) throw new ValidationError('this company has no books yet');
  useBaseCurrency(c.base_currency);
  return packFor(c.country_code);
}

/** What the console shows about the packs. */
export const packSummary = () => Object.values(PACKS).map((p) => ({
  country: p.country, name: p.name, currency: p.currency, taxAuthority: p.taxAuthority, vatForm: p.vatFormName,
  vat: p.vatForm ? `${p.taxCodes.find((t) => t.category === 'standard')?.rate ?? 0}%` : 'none', noVat: p.noVat ?? null,
  einvoice: p.einvoice === 'zatca' ? 'ZATCA (Fatoora) UBL 2.1 with QR code and hash chain' : p.einvoice === 'pint_ae' ? 'PINT AE (Peppol) UBL 2.1' : p.einvoiceGap ?? 'none',
  decimals: minorUnits(p.currency),
  taxCodes: p.taxCodes.map((t) => ({ code: t.code, name: t.name, rate: t.rate })),
  contributions: p.contributions.map((c) => ({ code: c.code, name: c.name, appliesTo: c.appliesTo, employeePct: c.employeePct, employerPct: c.employerPct, monthlyCap: c.monthlyCap,
    afterYears: c.afterYears ?? null, employerPctAfter: c.employerPctAfter ?? null })),
  endOfService: p.endOfServiceRule, payrollFile: p.wps ? 'WPS salary information file (SIF)' : null, payrollFileGap: p.payrollFileGap ?? null,
  corporateTax: p.corporateTaxGap ? 'not covered yet' : `${p.defaults.corporateTaxRate}% above ${p.defaults.corporateTaxThreshold.toLocaleString('en')}`,
}));
