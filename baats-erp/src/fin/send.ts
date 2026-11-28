import { ValidationError } from '../core/errors.ts';
import { one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { checkAddress, mailReady, queue } from '../int/mail.ts';
import { invoicePdf, invoiceView } from './invoicepdf.ts';

/**
 * Sending a posted invoice or credit note to the customer by email: the PDF, the
 * e-invoice XML when one was generated, and the card payment link when one is open.
 */
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const amount = (n: number, cur: string) => `${cur} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: ['KWD', 'BHD', 'OMR'].includes(cur) ? 3 : 2, maximumFractionDigits: 3 })}`;

export async function emailInvoice(tx: Tx, ctx: Ctx, invoiceId: string, input: { to?: string[]; cc?: string[]; message?: string }) {
  const { inv, company: c, outstanding: due, paymentLink } = await invoiceView(tx, ctx, invoiceId);
  await authorize(tx, ctx, 'int.mail.send', { unitId: inv.company_id });
  if (!inv.kind.startsWith('sales')) throw new ValidationError('only sales invoices and credit notes are sent to customers');
  if (!(await mailReady(tx))) throw new ValidationError('email is not set up yet: an administrator sets it up under Connectors');
  const to = (input.to?.length ? input.to : [inv.party_attributes?.email].filter(Boolean)).map((a: string) => checkAddress(a));
  if (!to.length) throw new ValidationError(`${inv.party_name} has no email address; give one`);
  const { name, pdf } = await invoicePdf(tx, ctx, invoiceId);
  const einv = await one(tx, 'SELECT xml FROM fin.einvoices WHERE invoice_id = $1', [invoiceId]);
  const credit = inv.kind === 'sales_credit';
  const what = credit ? 'credit note' : 'invoice';
  const intro = input.message?.trim() || `Please find attached our ${what} ${inv.no}.`;
  const payLines = !credit && due > 0.0005 ? [
    `Amount due: ${amount(due, inv.currency)}${inv.due_date ? `, by ${String(inv.due_date instanceof Date ? inv.due_date.toISOString() : inv.due_date).slice(0, 10)}` : ''}.`,
    ...(c.iban ? [`Bank transfer: IBAN ${c.iban}, quoting ${inv.no}.`] : []),
    ...(paymentLink ? [`Pay by card: ${paymentLink.url}`] : []),
  ] : [];
  const text = `Dear ${inv.party_name},\n\n${intro}\n\n${payLines.join('\n')}${payLines.length ? '\n\n' : ''}Kind regards,\n${c.legal_name}\n`;
  const html = `<p>Dear ${esc(inv.party_name)},</p><p>${esc(intro).replace(/\n/g, '<br>')}</p>` +
    (payLines.length ? `<p>${payLines.map((l) => l.startsWith('Pay by card') && paymentLink ? `<a href="${esc(paymentLink.url)}" style="display:inline-block;padding:10px 18px;background:#0b5;color:#fff;border-radius:6px;text-decoration:none">Pay ${esc(amount(due, inv.currency))} by card</a>` : esc(l)).join('<br>')}</p>` : '') +
    `<p>Kind regards,<br>${esc(c.legal_name)}</p>`;
  const attachments = [{ name, contentType: 'application/pdf', base64: pdf.toString('base64') },
    ...(einv ? [{ name: `${inv.no}.xml`, contentType: 'application/xml', base64: Buffer.from(einv.xml).toString('base64') }] : [])];
  const m = await queue(tx, ctx.userId, { kind: credit ? 'credit_note' : 'invoice', entityType: 'fin.invoice', entityId: inv.id, to, cc: input.cc,
    subject: `${credit ? 'Credit note' : 'Invoice'} ${inv.no} from ${c.legal_name}`, text, html, attachments });
  return { ...m, to, attachments: attachments.map((a) => a.name) };
}
