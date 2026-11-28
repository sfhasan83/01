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
