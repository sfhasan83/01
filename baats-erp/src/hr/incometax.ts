import { ValidationError } from '../core/errors.ts';
import { roundMoney } from '../core/money.ts';

/**
 * Income tax withheld from monthly pay.
 *
 * UK PAYE (tax year 2026/27, 6 April to 5 April): cumulative, with the tax code
 * giving the tax-free pay. Monthly payrolls are tax months 1 (April) to 12 (March).
 * Tax-free pay and the bands are taken in proportion to the month; taxable pay is
 * rounded down to whole pounds. K codes add to taxable pay and are limited to half
 * of the month's pay. W1/M1 (or X) codes are worked out on the month alone.
 * Bands: England, Wales (C) and Northern Ireland 20% to 37,700, 40% to 125,140,
 * 45% above; Scotland (S) 19% to 2,827, 20% to 14,921, 21% to 31,092, 42% to
 * 62,430, 45% to 125,140 and 48% above.
 *
 * Irish PAYE and USC (2026): cumulative over the calendar year, from the Revenue
 * Payroll Notification's yearly tax credits and standard rate cut-off: 20% up to
 * the cut-off and 40% above, less the credits; USC 0.5% to 12,012, 2% to 28,700,
 * 3% to 70,044 and 8% above, nothing for incomes of 13,000 a year or less.
 */

type Band = [upTo: number, rate: number];
export const UK_BANDS: Band[] = [[37700, 20], [125140, 40], [Infinity, 45]];
export const SCOTTISH_BANDS: Band[] = [[2827, 19], [14921, 20], [31092, 21], [62430, 42], [125140, 45], [Infinity, 48]];
const FLAT: Record<string, { rUK: number; S: number }> = { BR: { rUK: 20, S: 20 }, D0: { rUK: 40, S: 21 }, D1: { rUK: 45, S: 42 }, D2: { rUK: 45, S: 45 }, D3: { rUK: 45, S: 48 } };

export interface UkCode { region: 'rUK' | 'S'; allowance: number; flat: number | null; none: boolean; cumulative: boolean; k: boolean }

/** Read a UK tax code such as 1257L, S1257L, C1257L, K475, BR, D0, NT, 0T, 1257L M1 or 1257L X. */
export function parseUkTaxCode(raw: string): UkCode {
  let code = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  let cumulative = true;
  const nc = code.match(/^(.*?)(?: ?(W1|M1|X))$/);
  if (nc && nc[1]) { code = nc[1].trim(); cumulative = false; }
  let region: 'rUK' | 'S' = 'rUK';
  if (/^[SC](?=\d|K|BR|D\d|NT|0T)/.test(code)) { region = code[0] === 'S' ? 'S' : 'rUK'; code = code.slice(1); }
  if (code === 'NT') return { region, allowance: 0, flat: 0, none: true, cumulative, k: false };
  if (FLAT[code]) return { region, allowance: 0, flat: FLAT[code][region], none: false, cumulative, k: false };
  if (code === '0T') return { region, allowance: 0, flat: null, none: false, cumulative, k: false };
  let m = code.match(/^(\d{1,5})[LMNT]$/);
  if (m) return { region, allowance: Number(m[1]) * 10 + 9, flat: null, none: false, cumulative, k: false };
  m = code.match(/^K(\d{1,5})$/);
  if (m) return { region, allowance: -(Number(m[1]) * 10 + 9), flat: null, none: false, cumulative, k: true };
  throw new ValidationError(`"${raw}" is not a UK tax code (for example 1257L, S1257L, K475, BR, D0, NT or 1257L M1)`);
}

/** Tax month of a monthly payroll period (YYYY-MM): April is month 1, March month 12; and the tax year it belongs to. */
export function ukTaxMonth(period: string): { month: number; taxYear: number; yearFrom: string; yearTo: string } {
  const [y, m] = period.split('-').map(Number);
  const taxYear = m >= 4 ? y : y - 1;
  return { month: ((m + 8) % 12) + 1, taxYear, yearFrom: `${taxYear}-04`, yearTo: `${taxYear + 1}-03` };
}

const bandTax = (taxable: number, bands: Band[], share: number) => {
  let tax = 0, lower = 0;
  for (const [upTo, rate] of bands) {
    const top = upTo === Infinity ? Infinity : Math.ceil(upTo * share);
    if (taxable <= lower) break;
    tax += (Math.min(taxable, top) - lower) * rate / 100;
    lower = top;
  }
  return tax;
};

/**
 * UK PAYE for one month. payToDate and taxToDate are this tax year's earlier taxable pay and tax
 * (including a previous employer's from the P45); pay is this month's taxable pay.
 */
export function ukPaye(code: string, taxMonth: number, pay: number, payToDate: number, taxToDate: number): number {
  const c = parseUkTaxCode(code);
  if (c.none) return 0;
  const n = c.cumulative ? taxMonth : 1;
  const cumPay = c.cumulative ? payToDate + pay : pay;
  const before = c.cumulative ? taxToDate : 0;
  let due: number;
  if (c.flat !== null) due = roundMoney(cumPay * c.flat / 100);
  else {
    const freePay = c.allowance * n / 12;
    const taxable = Math.max(0, Math.floor(cumPay - freePay));
    due = roundMoney(bandTax(taxable, c.region === 'S' ? SCOTTISH_BANDS : UK_BANDS, n / 12));
  }
  let tax = roundMoney(due - before);
  if (c.k) tax = Math.min(tax, roundMoney(pay / 2)); // the overriding limit for K codes
  return tax;
}

export const IE_USC_BANDS: Band[] = [[12012, 0.5], [28700, 2], [70044, 3], [Infinity, 8]];
export const IE_USC_EXEMPT = 13000;

/** Irish PAYE and USC for month n of the year, cumulative. Credits and cut-off are the yearly amounts on the RPN. */
export function irelandPaye(month: number, pay: number, payToDate: number, payeToDate: number, uscToDate: number,
  rpn: { credits: number; cutOff: number }, yearlyPay: number): { paye: number; usc: number } {
  const cum = payToDate + pay, share = month / 12;
  const cut = rpn.cutOff * share;
  const gross = Math.min(cum, cut) * 0.2 + Math.max(0, cum - cut) * 0.4;
  const paye = roundMoney(Math.max(0, gross - rpn.credits * share) - payeToDate);
  const usc = yearlyPay <= IE_USC_EXEMPT ? 0 : roundMoney(bandTax(cum, IE_USC_BANDS, share) - uscToDate);
  return { paye, usc };
}

type Slab = [from: number, rate: number];
const slabTax = (income: number, slabs: Slab[]) => {
  let tax = 0;
  for (let i = 0; i < slabs.length; i++) {
    const [from, rate] = slabs[i], to = slabs[i + 1]?.[0] ?? Infinity;
    if (income > from) tax += (Math.min(income, to) - from) * rate / 100;
  }
  return tax;
};

/**
 * Surcharge on tax for income above a threshold, with marginal relief: the tax and
 * surcharge never exceed the tax at the threshold plus the income above it.
 */
const withSurcharge = (income: number, tax: (x: number) => number, steps: [over: number, pct: number][]) => {
  const base = tax(income);
  let i = steps.length - 1;
  while (i >= 0 && income <= steps[i][0]) i--;
  if (i < 0) return base;
  const [over, pct] = steps[i];
  const below = i > 0 ? steps[i - 1][1] : 0;
  const atThreshold = tax(over) * (1 + below / 100);
  return Math.min(base * (1 + pct / 100), atThreshold + (income - over));
};

/** India, new regime (section 115BAC), financial year 2025-26. */
export const IN_STANDARD_DEDUCTION = 75000;
export const IN_SLABS: Slab[] = [[0, 0], [400000, 5], [800000, 10], [1200000, 15], [1600000, 20], [2000000, 25], [2400000, 30]];
export const IN_REBATE_LIMIT = 1200000;
export const IN_SURCHARGE: [number, number][] = [[5000000, 10], [10000000, 15], [20000000, 25]];

/**
 * Income tax on a year's salary under India's new regime: the standard deduction,
 * the slabs, the section 87A rebate (no tax up to INR 12 lakh of taxable income,
 * marginal relief just above it), surcharge above INR 50 lakh with marginal relief
 * (at most 25%), and 4% health and education cess.
 */
export function indiaAnnualTax(salary: number): number {
  const income = Math.max(0, salary - IN_STANDARD_DEDUCTION);
  if (income <= IN_REBATE_LIMIT) return 0;
  const afterRebate = (x: number) => (x <= IN_REBATE_LIMIT ? 0 : Math.min(slabTax(x, IN_SLABS), x - IN_REBATE_LIMIT));
  const tax = withSurcharge(income, afterRebate, IN_SURCHARGE);
  return roundMoney(tax * 1.04);
}

/** Pakistan, salaried persons, tax year 2026 (1 July 2025 to 30 June 2026), First Schedule Part I Division I clause (1A). */
export const PK_SLABS: Slab[] = [[0, 0], [600000, 1], [1200000, 11], [2200000, 23], [3200000, 30], [4100000, 35]];
export const PK_SURCHARGE_ABOVE = 10000000;

/** Income tax on a year's salary in Pakistan, with the 9% surcharge for salaried persons above PKR 10 million. */
export function pakistanAnnualTax(salary: number): number {
  const tax = slabTax(Math.max(0, salary), PK_SLABS);
  return roundMoney(salary > PK_SURCHARGE_ABOVE ? tax * 1.09 : tax);
}

/** Month of the tax year (1 to 12) of a payroll period, and the period the tax year starts. */
export function fiscalMonth(period: string, startMonth: number): { month: number; yearFrom: string; yearTo: string } {
  const [y, m] = period.split('-').map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1, endYear = startMonth === 1 ? startYear : startYear + 1;
  return { month: ((m - startMonth + 12) % 12) + 1, yearFrom: `${startYear}-${String(startMonth).padStart(2, '0')}`, yearTo: `${endYear}-${String(endMonth).padStart(2, '0')}` };
}

/**
 * Tax withheld this month where the law taxes the year's salary (India section 192,
 * Pakistan section 149): the year's salary is estimated as what was paid so far, this
 * month's pay and the regular monthly pay for the months left; the year's tax less
 * what was withheld so far is spread evenly over this month and the months left.
 */
export function annualSlabWithholding(annualTax: (y: number) => number, pay: number, regular: number, monthsLeft: number,
  payToDate: number, taxToDate: number): { tax: number; projected: number; yearTax: number } {
  const projected = payToDate + pay + regular * monthsLeft;
  const yearTax = annualTax(projected);
  return { tax: roundMoney(Math.max(0, (yearTax - taxToDate) / (monthsLeft + 1))), projected: roundMoney(projected), yearTax };
}
