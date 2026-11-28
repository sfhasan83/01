import { roundMoney } from '../core/money.ts';
import { UAE_CHART, type AccountTemplate } from './coa.ts';
import type { ContributionTemplate, CountryPack, EndReason, TaxCodeTemplate } from './country.ts';

/**
 * The United Kingdom and EU country packs: Ireland, Germany, France, the
 * Netherlands, Spain and Italy. They share the BAATS chart (with each country's
 * names for the tax and payroll accounts), VAT codes that tell domestic sales,
 * EU supplies and exports apart (the VAT return and the EC sales list are built
 * from them), payroll with employee and employer contributions between monthly
 * thresholds, and income tax withheld from pay.
 *
 * Rates and thresholds a government changes every year (social contributions)
 * are seeded into each company's settings, where they are corrected without a
 * new release. Tax bands used by the UK and Irish PAYE calculations are in
 * src/hr/incometax.ts with the tax year they belong to.
 */

/** EU member states, for telling EU customers and suppliers from the rest of the world. */
export const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

/** The BAATS chart with the country's names for some accounts, and a liability for income tax withheld from pay. */
const chart = (names: Record<string, string>, withheld: string): AccountTemplate[] => {
  const out = UAE_CHART.map((a) => (names[a.code] ? { ...a, name: names[a.code] } : a));
  const at = out.findIndex((a) => a.code === '2230');
  out.splice(at + 1, 0, { code: '2240', name: withheld, type: 'liability', parent: '21', kind: 'L', role: 'income_tax_withheld', manual: false });
  return out;
};

/**
 * VAT codes for an EU country. The e-invoice category (UNCL5305) tells the VAT
 * return what each line is: S standard or reduced, Z zero rated, E exempt,
 * K intra-community supply of goods, AE services to an EU business (the customer
 * accounts for the VAT), G export outside the EU, O out of scope. Purchases use
 * the same codes; ICA and RCS are self-assessed (reverse charge).
 */
const euCodes = (standard: number, reduced: { rate: number; label: string }[]): TaxCodeTemplate[] => [
  { code: 'SR', name: `Standard rated ${standard}%`, category: 'standard', rate: standard, einvoice: 'S' },
  ...reduced.map((r, i) => ({ code: i === 0 ? 'RR' : `RR${i + 1}`, name: `Reduced rate ${r.rate}%: ${r.label}`, category: 'standard' as const, rate: r.rate, einvoice: 'S' })),
  { code: 'ZR', name: 'Zero rated (domestic)', category: 'zero', rate: 0, einvoice: 'Z' },
  { code: 'EX', name: 'Exempt', category: 'exempt', rate: 0, einvoice: 'E', exemptionReason: 'Exempt supply' },
  { code: 'IC', name: 'Intra-community supply of goods (to an EU business)', category: 'zero', rate: 0, einvoice: 'K', exemptionCode: 'VATEX-EU-IC',
    exemptionReason: 'Intra-community supply' },
  { code: 'ICS', name: 'Services to an EU business (customer accounts for the VAT)', category: 'zero', rate: 0, einvoice: 'AE', exemptionCode: 'VATEX-EU-AE',
    exemptionReason: 'Reverse charge' },
  { code: 'EXP', name: 'Export outside the EU', category: 'zero', rate: 0, einvoice: 'G', exemptionCode: 'VATEX-EU-G', exemptionReason: 'Export outside the EU' },
  { code: 'OS', name: 'Out of scope', category: 'out_of_scope', rate: 0, einvoice: 'O', exemptionCode: 'VATEX-EU-O', exemptionReason: 'Not subject to VAT' },
  { code: 'ICA', name: `Intra-community acquisition of goods ${standard}% (self-assessed)`, category: 'reverse_charge', rate: standard, einvoice: 'K' },
  { code: 'RCS', name: `Services from abroad ${standard}% (reverse charge)`, category: 'reverse_charge', rate: standard, einvoice: 'AE' },
];

const DAY = 86_400_000;
const yearsOf = (joined: string, at: string) => (Date.parse(`${at}T00:00:00Z`) - Date.parse(`${joined}T00:00:00Z`)) / DAY / 365.25;
const monthly = (pay: { basic: number; housing: number }) => pay.basic + pay.housing;
const dismissal = (reason?: EndReason | null) => reason === 'termination';

/**
 * France, indemnité légale de licenciement (Code du travail R1234-2): a quarter of
 * a month's pay for each of the first ten years and a third after, from eight
 * months' service, on dismissal or a rupture conventionnelle. Nothing is owed on
 * resignation, so nothing is provided until it is due.
 */
export function franceEndOfService(pay: { basic: number; housing: number }, joined: string, at: string, reason?: EndReason | null): number {
  if (!(dismissal(reason) || reason === 'mutual') || at <= joined) return 0;
  const years = yearsOf(joined, at);
  if (years < 8 / 12) return 0;
  const w = monthly(pay);
  return roundMoney(Math.min(years, 10) * w / 4 + Math.max(0, years - 10) * w / 3);
}

/**
 * Netherlands, transitievergoeding (BW 7:673): a third of a month's pay for each
 * year of service, from the first day, when the employer ends or does not renew
 * the contract; at most EUR 102,000 (2026) or a year's pay if that is higher.
 */
export const NL_TRANSITION_CAP = 102000;
export function netherlandsEndOfService(pay: { basic: number; housing: number }, joined: string, at: string, reason?: EndReason | null): number {
  if (!(dismissal(reason) || reason === 'contract_end') || at <= joined) return 0;
  const w = monthly(pay);
  return roundMoney(Math.min(yearsOf(joined, at) * w / 3, Math.max(NL_TRANSITION_CAP, 12 * w)));
}

/**
 * Spain (Estatuto de los Trabajadores art. 52-53 and 49.1.c): on an objective
 * dismissal 20 days' pay a year of service, at most twelve months; at the end of a
 * temporary contract 12 days a year. The daily pay is a year's pay over 365.
 */
export function spainEndOfService(pay: { basic: number; housing: number }, joined: string, at: string, reason?: EndReason | null): number {
  if (at <= joined) return 0;
  const daily = monthly(pay) * 12 / 365;
  const years = yearsOf(joined, at);
  if (dismissal(reason)) return roundMoney(Math.min(years * 20 * daily, 12 * monthly(pay)));
  if (reason === 'contract_end') return roundMoney(years * 12 * daily);
  return 0;
}

/**
 * Italy, trattamento di fine rapporto (Codice civile art. 2120): each year of
 * service sets aside a year's pay (thirteen months) divided by 13.5, owed whatever
 * the reason the employment ends, so it is provided as it accrues. The yearly
 * revaluation (1.5% plus three quarters of inflation) and the 0.5% INPS offset are
 * not applied.
 */
export function italyEndOfService(pay: { basic: number; housing: number }, joined: string, at: string): number {
  if (at <= joined) return 0;
  return roundMoney(yearsOf(joined, at) * 13 * monthly(pay) / 13.5);
}

/**
 * UK corporation tax: 19% on profits up to the lower limit, the main rate (25%)
 * from five times the lower limit, and marginal relief in between
 * (3/200 of the difference to the upper limit). The lower limit is the company's
 * corporate tax threshold, GBP 50,000 by default; divide it by the number of
 * associated companies, or shorten it for a short accounting period, there.
 */
export function ukCorporationTax(profit: number, mainRate: number, lowerLimit: number): number {
  if (profit <= 0) return 0;
  const upper = lowerLimit * 5;
  if (profit <= lowerLimit) return roundMoney(profit * 0.19);
  if (profit >= upper) return roundMoney(profit * mainRate / 100);
  return roundMoney(profit * mainRate / 100 - (upper - profit) * 3 / 200);
}

/** A lower rate on profits up to a band, the standard rate above (France 15%, the Netherlands 19%). */
const banded = (lowRate: number) => (profit: number, rate: number, band: number) =>
  profit <= 0 ? 0 : roundMoney(Math.min(profit, band) * lowRate / 100 + Math.max(0, profit - band) * rate / 100);

const NO_EOS = (country: string, why: string) => ({ endOfServiceRule: `no end-of-service benefit in ${country}; ${why}`, endOfService: () => 0 });

/** Contribution rule shorthand: employee %, employer %, monthly threshold and cap, on gross pay, for everyone. */
const C = (code: string, name: string, employeePct: number, employerPct: number, monthlyThreshold: number | null, monthlyCap: number | null,
  preTax = false): ContributionTemplate => ({ code, name, appliesTo: 'all', employeePct, employerPct, base: 'gross', monthlyCap, monthlyThreshold, preTax });

/**
 * United Kingdom. VAT 20% (reduced 5%), the nine-box return filed through Making
 * Tax Digital. PAYE income tax with tax codes, National Insurance (category A)
 * and auto-enrolment pension on qualifying earnings, at 2026/27 thresholds.
 */
export const UK: CountryPack = {
  country: 'GB', name: 'United Kingdom', currency: 'GBP', taxAuthority: 'HMRC', vatForm: 'GB-VAT100', vatFormName: 'HMRC VAT return (9 boxes, Making Tax Digital)',
  region: 'UK',
  chart: chart({ '2100': 'Output VAT', '2110': 'VAT Payable to HMRC', '2220': 'National Insurance and Pension Contributions Payable',
    '5930': 'Employer National Insurance and Pension Contributions', '2400': 'Corporation Tax Payable', '5950': 'Corporation Tax Expense',
    '2500': 'Termination Benefits Provision', '5920': 'Termination Benefits Expense' }, 'PAYE Income Tax Payable to HMRC'),
  taxCodes: [
    { code: 'SR', name: 'Standard rated 20%', category: 'standard', rate: 20, einvoice: 'S' },
    { code: 'RR', name: 'Reduced rate 5%: domestic fuel and power, children\'s car seats', category: 'standard', rate: 5, einvoice: 'S' },
    { code: 'ZR', name: 'Zero rated: food, books, children\'s clothing', category: 'zero', rate: 0, einvoice: 'Z' },
    { code: 'EX', name: 'Exempt: insurance, finance, education, health', category: 'exempt', rate: 0, einvoice: 'E', exemptionReason: 'Exempt supply' },
    { code: 'EXP', name: 'Export of goods (zero rated)', category: 'zero', rate: 0, einvoice: 'G', exemptionReason: 'Export' },
    { code: 'OS', name: 'Outside the scope (including services to customers abroad)', category: 'out_of_scope', rate: 0, einvoice: 'O', exemptionReason: 'Outside the scope of UK VAT' },
    { code: 'RCS', name: 'Services from abroad 20% (reverse charge)', category: 'reverse_charge', rate: 20, einvoice: 'AE' },
    { code: 'PVA', name: 'Imported goods 20% (postponed VAT accounting)', category: 'reverse_charge', rate: 20, einvoice: 'K' },
  ],
  taxNumber: { test: (s) => /^(GB)?\d{9}(\d{3})?$/.test(s.replace(/\s/g, '')), message: 'a UK VAT registration number has 9 digits, optionally after GB' },
  iban: { re: /^GB\d{2}[A-Z]{4}\d{14}$/, message: 'a UK IBAN is GB, 2 check digits, a 4-letter bank code and 14 digits (sort code and account number)' },
  defaults: { corporateTaxRate: 25, corporateTaxThreshold: 50000 },
  corporateTaxGap: null,
  corporateTax: ukCorporationTax,
  corporateTaxRule: '19% up to the lower limit (the threshold, GBP 50,000), 25% from five times it, marginal relief in between',
  einvoice: null,
  einvoiceGap: 'the UK has no e-invoicing mandate yet; invoices are printed or sent as PDF',
  wps: false, sepa: false,
  payrollFileGap: 'the RTI full payment submission to HMRC is not sent from BAATS yet; file it with HMRC\'s Basic PAYE Tools from the payslips',
  incomeTax: { method: 'uk_paye', rule: 'PAYE on the cumulative basis with the employee\'s tax code (1257L, BR, D0, K codes, S and C prefixes, W1/M1)' },
  contributions: [
    C('NI_EE_MAIN', 'Employee National Insurance (main rate)', 8, 0, 1048, 4189),
    C('NI_EE_UPPER', 'Employee National Insurance (above the upper earnings limit)', 2, 0, 4189, null),
    C('NI_ER', 'Employer National Insurance', 0, 15, 417, null),
    C('PENSION_AE', 'Workplace pension (auto-enrolment, net pay arrangement)', 5, 3, 520, 4189, true),
  ],
  ...NO_EOS('the UK', 'statutory redundancy pay is entered as an addition on the final payroll'),
};

export const IRELAND: CountryPack = {
  country: 'IE', name: 'Ireland', currency: 'EUR', taxAuthority: 'Revenue', vatForm: 'IE-VAT3', vatFormName: 'Revenue VAT3 return', region: 'EU',
  chart: chart({ '2100': 'Output VAT', '2110': 'VAT Payable to Revenue', '2220': 'PRSI and Pension Contributions Payable', '5930': 'Employer PRSI',
    '2400': 'Corporation Tax Payable', '5950': 'Corporation Tax Expense', '2500': 'Termination Benefits Provision', '5920': 'Termination Benefits Expense' },
    'PAYE and USC Payable to Revenue'),
  taxCodes: euCodes(23, [{ rate: 13.5, label: 'fuel, construction, repairs' }, { rate: 9, label: 'newspapers, sporting facilities' }]),
  taxNumber: { test: (s) => /^(IE)?\d{7}[A-W][A-IW]?$/.test(s.replace(/\s/g, '')) || /^(IE)?\d[A-Z+*]\d{5}[A-W]$/.test(s.replace(/\s/g, '')), message: 'an Irish VAT number is 7 digits and one or two letters, optionally after IE' },
  iban: { re: /^IE\d{2}[A-Z]{4}\d{14}$/, message: 'an Irish IBAN is IE, 2 check digits, a 4-letter bank code and 14 digits' },
  defaults: { corporateTaxRate: 12.5, corporateTaxThreshold: 0 },
  corporateTaxGap: null,
  corporateTaxRule: '12.5% on trading income; the 25% rate on passive income and the 15% minimum for large groups are not covered',
  einvoice: 'peppol', wps: false, sepa: true,
  payrollFileGap: 'the payroll submission to Revenue (PAYE Modernisation) is not sent from BAATS yet; submit it through ROS from the payslips',
  incomeTax: { method: 'ie_paye', rule: 'PAYE at 20% up to the standard rate cut-off and 40% above, less tax credits, and USC, cumulative from the employee\'s Revenue Payroll Notification' },
  contributions: [C('PRSI_A', 'PRSI class A1 (employer 8.9% below EUR 527 a week)', 4.2, 11.25, null, null)],
  ...NO_EOS('Ireland', 'statutory redundancy pay is entered as an addition on the final payroll'),
};

export const GERMANY: CountryPack = {
  country: 'DE', name: 'Germany', currency: 'EUR', taxAuthority: 'Finanzamt', vatForm: 'DE-UStVA', vatFormName: 'Umsatzsteuer-Voranmeldung (UStVA)', region: 'EU',
  chart: chart({ '2100': 'Umsatzsteuer (output VAT)', '1200': 'Vorsteuer (input VAT)', '2110': 'Umsatzsteuer-Zahllast (VAT payable to the Finanzamt)',
    '2220': 'Sozialversicherungsbeiträge (social insurance payable)', '5930': 'Arbeitgeberanteil Sozialversicherung (employer social insurance)',
    '2400': 'Körperschaft- und Gewerbesteuer (corporate and trade tax payable)', '5950': 'Körperschaft- und Gewerbesteuer (corporate and trade tax)',
    '2500': 'Rückstellungen Abfindungen (severance provision)', '5920': 'Abfindungen (severance)' }, 'Lohnsteuer (wage tax payable)'),
  taxCodes: euCodes(19, [{ rate: 7, label: 'food, books, public transport' }]),
  taxNumber: { test: (s) => /^(DE)?\d{9}$/.test(s.replace(/\s/g, '')) || /^\d{2,3}\/?\d{3}\/?\d{4,5}$/.test(s.replace(/\s/g, '')), message: 'enter the USt-IdNr (DE and 9 digits) or the Steuernummer' },
  iban: { re: /^DE\d{20}$/, message: 'a German IBAN is DE followed by 20 digits' },
  defaults: { corporateTaxRate: 29.83, corporateTaxThreshold: 0 },
  corporateTaxGap: null,
  corporateTaxRule: 'corporate tax 15% plus solidarity surcharge (15.825%) and trade tax at a 400% Hebesatz (14%); change the rate to your municipality\'s',
  einvoice: 'xrechnung', wps: false, sepa: true,
  payrollFileGap: 'DEÜV notifications and the Lohnsteuer-Anmeldung are not sent from BAATS yet; file them through ELSTER and your health insurers',
  incomeTax: { method: 'rate', rule: 'wage tax at each employee\'s rate on the contract',
    gap: 'Lohnsteuer, solidarity surcharge and church tax are not calculated from the official tables; set each employee\'s rate from ELStAM or your tax adviser' },
  contributions: [
    C('DE_RV', 'Rentenversicherung (pension)', 9.3, 9.3, null, 8450),
    C('DE_AV', 'Arbeitslosenversicherung (unemployment)', 1.3, 1.3, null, 8450),
    C('DE_KV', 'Krankenversicherung (health, with the average 2.9% additional rate)', 8.75, 8.75, null, 5812.5),
    C('DE_PV', 'Pflegeversicherung (long-term care; childless employees pay 0.6% more)', 1.8, 1.8, null, 5812.5),
    C('DE_INSO', 'Insolvenzgeldumlage', 0, 0.15, null, 8450),
  ],
  ...NO_EOS('Germany', 'a severance agreed with the employee is entered as an addition on the final payroll'),
};

export const FRANCE: CountryPack = {
  country: 'FR', name: 'France', currency: 'EUR', taxAuthority: 'DGFiP', vatForm: 'FR-CA3', vatFormName: 'Déclaration de TVA CA3', region: 'EU',
  chart: chart({ '2100': 'TVA collectée (output VAT)', '1200': 'TVA déductible (input VAT)', '2110': 'TVA à décaisser (VAT payable to the DGFiP)',
    '2220': 'Cotisations sociales à payer (URSSAF and retirement)', '5930': 'Charges sociales patronales (employer contributions)',
    '2400': 'Impôt sur les sociétés à payer', '5950': 'Impôt sur les sociétés', '2500': 'Provision pour indemnités de licenciement',
    '5920': 'Indemnités de licenciement' }, 'Prélèvement à la source (income tax withheld)'),
  taxCodes: euCodes(20, [{ rate: 10, label: 'restaurants, transport, renovation' }, { rate: 5.5, label: 'food, books, energy' }, { rate: 2.1, label: 'medicines, press' }]),
  taxNumber: { test: (s) => /^(FR)?[A-Z0-9]{2}\d{9}$/.test(s.replace(/\s/g, '')), message: 'a French VAT number is FR, 2 characters and the 9-digit SIREN' },
  iban: { re: /^FR\d{12}[A-Z0-9]{11}\d{2}$/, message: 'a French IBAN is FR followed by 25 characters' },
  defaults: { corporateTaxRate: 25, corporateTaxThreshold: 42500 },
  corporateTaxGap: null,
  corporateTax: banded(15),
  corporateTaxRule: '15% up to the threshold (EUR 42,500 for small companies that qualify; set it to 0 otherwise), 25% above',
  einvoice: null,
  einvoiceGap: 'French e-invoicing goes through a certified platform (PA) from September 2026; Factur-X invoices are not produced from BAATS yet',
  wps: false, sepa: true,
  payrollFileGap: 'the DSN is not sent from BAATS yet; file it through net-entreprises from the payslips',
  incomeTax: { method: 'rate', rule: 'prélèvement à la source at the rate the DGFiP sends for each employee, on taxable net pay' },
  contributions: [
    C('FR_VIEIL_PLAF', 'Assurance vieillesse plafonnée', 6.9, 8.55, null, 4005, true),
    C('FR_VIEIL_DEPL', 'Assurance vieillesse déplafonnée', 0.4, 2.11, null, null, true),
    C('FR_MALADIE', 'Assurance maladie', 0, 13, null, null, true),
    C('FR_ALLOC_FAM', 'Allocations familiales', 0, 5.25, null, null, true),
    C('FR_CHOMAGE', 'Assurance chômage', 0, 4.05, null, 16020, true),
    C('FR_AGS', 'AGS (garantie des salaires)', 0, 0.25, null, 16020, true),
    C('FR_AGIRC_T1', 'Retraite complémentaire Agirc-Arrco T1', 3.15, 4.72, null, 4005, true),
    C('FR_CEG_T1', 'Contribution d\'équilibre général T1', 0.86, 1.29, null, 4005, true),
    C('FR_AT_MP', 'Accidents du travail (set your notified rate)', 0, 2, null, null, true),
    C('FR_FNAL_CSA', 'FNAL and solidarity contribution', 0, 0.4, null, null, true),
    C('FR_CSG_DED', 'CSG déductible (6.8% of 98.25% of pay)', 6.68, 0, null, null, true),
    C('FR_CSG_CRDS', 'CSG non déductible and CRDS (2.9% of 98.25% of pay)', 2.85, 0, null, null),
  ],
  endOfServiceRule: 'on dismissal or rupture conventionnelle after 8 months: a quarter of a month\'s pay a year for 10 years, a third after',
  endOfService: franceEndOfService,
};

export const NETHERLANDS: CountryPack = {
  country: 'NL', name: 'Netherlands', currency: 'EUR', taxAuthority: 'Belastingdienst', vatForm: 'NL-OB', vatFormName: 'Aangifte omzetbelasting', region: 'EU',
  chart: chart({ '2100': 'Af te dragen omzetbelasting (output VAT)', '1200': 'Te vorderen omzetbelasting (input VAT)', '2110': 'Omzetbelasting (VAT payable to the Belastingdienst)',
    '2220': 'Premies werknemersverzekeringen (employee insurance payable)', '5930': 'Werkgeverslasten (employer contributions)',
    '2400': 'Vennootschapsbelasting (corporate tax payable)', '5950': 'Vennootschapsbelasting', '2500': 'Voorziening transitievergoeding',
    '5920': 'Transitievergoeding' }, 'Loonheffing (wage tax payable)'),
  taxCodes: euCodes(21, [{ rate: 9, label: 'food, books, medicines' }]),
  taxNumber: { test: (s) => /^(NL)?\d{9}B\d{2}$/.test(s.replace(/\s/g, '')), message: 'a Dutch VAT number is NL, 9 digits, B and 2 digits' },
  iban: { re: /^NL\d{2}[A-Z]{4}\d{10}$/, message: 'a Dutch IBAN is NL, 2 check digits, a 4-letter bank code and 10 digits' },
  defaults: { corporateTaxRate: 25.8, corporateTaxThreshold: 200000 },
  corporateTaxGap: null,
  corporateTax: banded(19),
  corporateTaxRule: '19% up to EUR 200,000, 25.8% above',
  einvoice: 'peppol', wps: false, sepa: true,
  payrollFileGap: 'the loonaangifte is not sent from BAATS yet; file it through your payroll provider or the Belastingdienst portal',
  incomeTax: { method: 'rate', rule: 'loonheffing (wage tax and national insurance) at each employee\'s rate on the contract',
    gap: 'loonheffing is not calculated from the white and green tables; set each employee\'s rate from the Belastingdienst tables' },
  contributions: [
    C('NL_AWF', 'WW Algemeen Werkloosheidsfonds (low rate; 5 points more for flexible contracts)', 0, 2.74, null, 6617),
    C('NL_AOF', 'WAO/WIA Arbeidsongeschiktheidsfonds', 0, 6.28, null, 6617),
    C('NL_ZVW', 'Zorgverzekeringswet (employer health contribution)', 0, 6.51, null, 6617),
  ],
  endOfServiceRule: 'transitievergoeding when the employer ends or does not renew the contract: a third of a month\'s pay a year, at most EUR 102,000 or a year\'s pay',
  endOfService: netherlandsEndOfService,
};

export const SPAIN: CountryPack = {
  country: 'ES', name: 'Spain', currency: 'EUR', taxAuthority: 'AEAT', vatForm: 'ES-303', vatFormName: 'Modelo 303 (IVA)', region: 'EU',
  chart: chart({ '2100': 'IVA repercutido (output VAT)', '1200': 'IVA soportado (input VAT)', '2110': 'Hacienda Pública acreedora por IVA',
    '2220': 'Organismos de la Seguridad Social acreedores', '5930': 'Seguridad Social a cargo de la empresa', '2400': 'Impuesto sobre Sociedades a pagar',
    '5950': 'Impuesto sobre Sociedades', '2500': 'Provisión por indemnizaciones', '5920': 'Indemnizaciones' }, 'Retenciones IRPF (income tax withheld)'),
  taxCodes: euCodes(21, [{ rate: 10, label: 'hospitality, transport, housing' }, { rate: 4, label: 'bread, milk, books, medicines' }]),
  taxNumber: { test: (s) => /^(ES)?[A-Z0-9]\d{7}[A-Z0-9]$/.test(s.replace(/\s/g, '')), message: 'a Spanish NIF is 9 characters, optionally after ES' },
  iban: { re: /^ES\d{22}$/, message: 'a Spanish IBAN is ES followed by 22 digits' },
  defaults: { corporateTaxRate: 25, corporateTaxThreshold: 0 },
  corporateTaxGap: null,
  corporateTaxRule: '25% general rate; the reduced rates for small and new companies are set by changing the rate',
  einvoice: null,
  einvoiceGap: 'Spanish VeriFactu records and the B2B e-invoice (Facturae) are not produced from BAATS yet',
  wps: false, sepa: true,
  payrollFileGap: 'social security (SILTRA) and modelo 111 are not filed from BAATS yet; file them from the payslips',
  incomeTax: { method: 'rate', rule: 'IRPF withholding at each employee\'s percentage on the contract',
    gap: 'the IRPF percentage is not worked out from the AEAT procedure; set each employee\'s percentage from the AEAT calculator' },
  contributions: [
    C('ES_CC', 'Contingencias comunes', 4.7, 23.6, null, 5101.2),
    C('ES_DESEMPLEO', 'Desempleo (permanent contract)', 1.55, 5.5, null, 5101.2),
    C('ES_FP', 'Formación profesional', 0.1, 0.6, null, 5101.2),
    C('ES_FOGASA', 'FOGASA', 0, 0.2, null, 5101.2),
    C('ES_MEI', 'Mecanismo de Equidad Intergeneracional', 0.15, 0.75, null, 5101.2),
    C('ES_AT_EP', 'Accidentes de trabajo (set your activity rate)', 0, 1.5, null, 5101.2),
  ],
  endOfServiceRule: 'objective dismissal: 20 days\' pay a year, at most 12 months; end of a temporary contract: 12 days a year',
  endOfService: spainEndOfService,
};

export const ITALY: CountryPack = {
  country: 'IT', name: 'Italy', currency: 'EUR', taxAuthority: 'Agenzia delle Entrate', vatForm: 'IT-LIPE', vatFormName: 'Liquidazione periodica IVA (LIPE)', region: 'EU',
  chart: chart({ '2100': 'IVA a debito (output VAT)', '1200': 'IVA a credito (input VAT)', '2110': 'Erario c/IVA (VAT payable)',
    '2220': 'Debiti verso INPS (social security payable)', '5930': 'Oneri sociali (employer contributions)', '2400': 'Debiti per IRES e IRAP',
    '5950': 'IRES e IRAP', '2500': 'Fondo TFR (trattamento di fine rapporto)', '5920': 'Accantonamento TFR' }, 'Ritenute IRPEF (income tax withheld)'),
  taxCodes: euCodes(22, [{ rate: 10, label: 'hospitality, some foods' }, { rate: 5, label: 'health and social services' }, { rate: 4, label: 'basic food, books' }]),
  taxNumber: { test: (s) => /^(IT)?\d{11}$/.test(s.replace(/\s/g, '')), message: 'an Italian partita IVA has 11 digits, optionally after IT' },
  iban: { re: /^IT\d{2}[A-Z]\d{10}[A-Z0-9]{12}$/, message: 'an Italian IBAN is IT followed by 25 characters' },
  defaults: { corporateTaxRate: 24, corporateTaxThreshold: 0 },
  corporateTaxGap: null,
  corporateTaxRule: 'IRES 24%; IRAP (3.9% on the value of production) is not covered and is posted as a manual journal',
  einvoice: null,
  einvoiceGap: 'Italian invoices go through the SDI as FatturaPA XML; FatturaPA is not produced from BAATS yet',
  wps: false, sepa: true,
  payrollFileGap: 'UniEmens and the F24 are not filed from BAATS yet; file them from the payslips',
  incomeTax: { method: 'rate', rule: 'IRPEF withholding at each employee\'s rate on the contract, on pay after INPS contributions',
    gap: 'IRPEF with its deductions and the regional and municipal surcharges is not calculated; set each employee\'s rate from your consulente del lavoro' },
  contributions: [
    C('IT_INPS_IVS', 'INPS pensione (IVS)', 9.19, 23.81, null, null, true),
    C('IT_INPS_OTHER', 'INPS other (NASpI, CUAF, malattia, maternità; depends on sector)', 0, 5.5, null, null),
    C('IT_INAIL', 'INAIL (set your premium rate)', 0, 1, null, null),
  ],
  endOfServiceRule: 'TFR: a year\'s pay (13 months) divided by 13.5 for each year of service, whatever the reason employment ends',
  endOfService: italyEndOfService,
};

export const EUROPE_PACKS = { GB: UK, IE: IRELAND, DE: GERMANY, FR: FRANCE, NL: NETHERLANDS, ES: SPAIN, IT: ITALY };
