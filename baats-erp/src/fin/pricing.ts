import { ValidationError } from '../core/errors.ts';
import { one, type Tx } from '../core/db.ts';
import { roundIn } from '../core/money.ts';

export interface PricedLine { quantity: number; unitPrice: number; discount?: number; taxCode: string }

/**
 * Net and VAT per line, the same way invoices compute them, so an order total
 * equals the invoice that bills it. Reverse-charge VAT is self-assessed and is
 * not part of what the supplier is owed.
 */
export async function priceLines(tx: Tx, countryCode: string, currency: string, lines: PricedLine[]) {
  const roundMoney = (n: number) => roundIn(currency, n);
  let net = 0, tax = 0, rc = 0;
  const out = [];
  for (const [i, l] of lines.entries()) {
    if (!(l.quantity > 0) || !(l.unitPrice >= 0)) throw new ValidationError(`line ${i + 1}: quantity must be positive and price not negative`);
    const tc = await one(tx, 'SELECT * FROM fin.tax_codes WHERE country_code = $1 AND code = $2 AND active', [countryCode, l.taxCode]);
    if (!tc) throw new ValidationError(`line ${i + 1}: unknown tax code ${l.taxCode}`);
    const lineNet = roundMoney(l.quantity * l.unitPrice - (l.discount ?? 0));
    if (lineNet < 0) throw new ValidationError(`line ${i + 1}: discount is larger than the line amount`);
    const lineTax = roundMoney(lineNet * Number(tc.rate) / 100);
    net += lineNet; tax += lineTax;
    if (tc.category === 'reverse_charge') rc += lineTax;
    out.push({ net: lineNet, tax: lineTax, category: tc.category as string });
  }
  return { lines: out, net: roundMoney(net), tax: roundMoney(tax), gross: roundMoney(net + tax - rc) };
}
