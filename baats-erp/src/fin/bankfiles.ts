import { createHash, randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { fixed, roundIn } from '../core/money.ts';
import { authorize } from '../iam/authz.ts';
import { company, nextNumber, resolveAccount } from './ledger.ts';
import { importStatement, parseCsv, type StatementLine } from './bank.ts';

/**
 * The files banks exchange with their customers:
 *   statements   SWIFT MT940 and ISO 20022 CAMT.053 (most GCC banks offer one or both
 *                for download in online banking), read into bank reconciliation and
 *                matched to the ledger account by IBAN or account number;
 *   payments     ISO 20022 pain.001.001.03 credit transfers for supplier payments
 *                already posted in BAATS, uploaded in online banking to pay them.
 * Each bank account in the ledger has its bank details (bank, IBAN, BIC, currency).
 */

// --- Bank details ------------------------------------------------------------------------

/** An IBAN without spaces, upper case, with its check digits verified (ISO 13616, mod 97). */
export function normalizeIban(raw: string): string {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw new ValidationError(`${raw} is not an IBAN`);
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0;
  for (const d of digits) r = (r * 10 + Number(d)) % 97;
  if (r !== 1) throw new ValidationError(`the IBAN ${raw} has wrong check digits; check it for a typing mistake`);
  return iban;
}

export async function setBankDetails(tx: Tx, ctx: Ctx, companyId: string, input: { bankAccount: string; bankName: string; iban?: string; bic?: string; accountNo?: string; currency?: string }) {
  await authorize(tx, ctx, 'fin.account.manage', { unitId: companyId });
  const c = await company(tx, companyId);
  const acc = await resolveAccount(tx, companyId, input.bankAccount);
  const row = await one(tx, 'SELECT code, system_role, type, control, is_group FROM fin.accounts WHERE id = $1', [acc.id]);
  if (row.type !== 'asset' || row.control || row.is_group || !(row.system_role === 'bank' || row.code.startsWith('10'))) throw new ValidationError(`${row.code} is not a bank account`);
  const iban = input.iban ? normalizeIban(input.iban) : null;
  const bic = input.bic ? input.bic.replace(/\s+/g, '').toUpperCase() : null;
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) throw new ValidationError(`${input.bic} is not a BIC (SWIFT code): 8 or 11 letters and digits`);
  if (!iban && !input.accountNo) throw new ValidationError('give the IBAN or the account number');
  const taken = iban && await one(tx, 'SELECT account_id FROM fin.bank_details WHERE iban = $1 AND account_id <> $2', [iban, acc.id]);
  if (taken) throw new ConflictError(`the IBAN ${iban} is already on another bank account`);
  return one(tx, `INSERT INTO fin.bank_details (tenant_id, account_id, company_id, bank_name, iban, bic, account_no, currency)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (account_id) DO UPDATE SET bank_name = EXCLUDED.bank_name, iban = EXCLUDED.iban, bic = EXCLUDED.bic,
        account_no = EXCLUDED.account_no, currency = EXCLUDED.currency, updated_at = now() RETURNING *`,
  [acc.id, companyId, input.bankName.trim(), iban, bic, input.accountNo?.trim() || null, (input.currency ?? c.base_currency).toUpperCase()]);
}

export async function listBankDetails(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'fin.report.read', { unitId: companyId });
  return many(tx, `SELECT a.id AS account_id, a.code, a.name, d.bank_name, d.iban, d.bic, d.account_no, d.currency
                     FROM fin.accounts a LEFT JOIN fin.bank_details d ON d.account_id = a.id
                    WHERE a.company_id = $1 AND a.type = 'asset' AND NOT a.is_group AND a.control IS NULL
                      AND (a.system_role = 'bank' OR (a.code LIKE '10%' AND a.system_role IS DISTINCT FROM 'cash')) AND a.status = 'active'
                    ORDER BY a.code`, [companyId]);
}

// --- Statement files ---------------------------------------------------------------------

export interface ParsedStatement {
  format: 'csv' | 'mt940' | 'camt053';
  account?: string; currency?: string; reference?: string;
  openingBalance?: number; closingBalance?: number;
  lines: StatementLine[];
}

const yymmdd = (s: string) => `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
const swiftAmount = (s: string) => {
  const n = Number(s.replace(',', '.'));
  if (!Number.isFinite(n)) throw new ValidationError(`cannot read the amount "${s}"`);
  return n;
};

/** SWIFT MT940 (one or more statements of one account). */
export function parseMt940(text: string): ParsedStatement {
  // Join continuation lines to their field; blocks {1:...}{4: and -} are ignored.
  const fields: { tag: string; value: string }[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/^\{[1-5]:[^{}]*\}?/, '').replace(/^\{4:$/, '');
    if (!line || /^-\}?$/.test(line.trim())) continue;
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
    if (m) fields.push({ tag: m[1], value: m[2] });
    else if (fields.length) fields[fields.length - 1].value += '\n' + line;
  }
  if (!fields.some((f) => f.tag === '61') && !fields.some((f) => f.tag.startsWith('60'))) throw new ValidationError('this is not an MT940 statement');
  const out: ParsedStatement = { format: 'mt940', lines: [] };
  const balance = (v: string) => {
    const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/.exec(v.trim());
    if (!m) throw new ValidationError(`cannot read the balance "${v.trim()}"`);
    out.currency ??= m[3];
    if (m[3] !== out.currency) throw new ValidationError('the file has statements in more than one currency');
    return (m[1] === 'D' ? -1 : 1) * swiftAmount(m[4]);
  };
  let last: StatementLine | null = null;
  let firstOpening = true;
  for (const f of fields) {
    switch (f.tag) {
      case '20': out.reference ??= f.value.trim(); break;
      case '25': {
        const acc = f.value.trim().split('/').pop()!.replace(/\s+/g, '');
        if (out.account && out.account !== acc) throw new ValidationError('the file has statements of more than one account; download one account at a time');
        out.account = acc; break;
      }
      case '60F': case '60M': if (firstOpening) { out.openingBalance = balance(f.value); firstOpening = false; } break;
      case '62F': case '62M': out.closingBalance = balance(f.value); break;
      case '61': {
        const [first, ...more] = f.value.split('\n');
        const m = /^(\d{6})(\d{4})?(R?[CD])([A-Z])?(\d+,\d*)([NFS][A-Z0-9]{3})([^/]*?)(?:\/\/(.*))?$/.exec(first.trim());
        if (!m) throw new ValidationError(`cannot read the statement line ":61:${first}"`);
        const sign = m[3] === 'C' || m[3] === 'RD' ? 1 : -1;
        const ownRef = m[7].trim();
        last = { date: yymmdd(m[1]), description: more.join(' ').trim(), amount: sign * swiftAmount(m[5]),
          reference: ownRef && ownRef !== 'NONREF' ? ownRef : (m[8]?.trim() || undefined) };
        out.lines.push(last);
        break;
      }
      case '86':
        if (last) {
          // Structured :86: (?20, ?32 ... sub-fields) is flattened to its text.
          const text = f.value.replace(/\n/g, '').replace(/\?\d{2}/g, ' ').replace(/\s+/g, ' ').trim();
          last.description = [text, last.description].filter(Boolean).join(' · ').slice(0, 500);
        }
        break;
      default:
    }
  }
  for (const l of out.lines) if (!l.description) l.description = l.reference ?? '(no description)';
  return out;
}

const tagText = (xml: string, path: string[]): string | undefined => {
  let cur = xml;
  for (const t of path) {
    const m = new RegExp(`<(?:\\w+:)?${t}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${t}>`).exec(cur);
    if (!m) return undefined;
    cur = m[1];
  }
  return cur.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
};
const allTags = (xml: string, t: string) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${t}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${t}>`, 'g'))].map((m) => m[1]);

/** ISO 20022 CAMT.053 bank-to-customer statement (any version from 001.02 on). */
export function parseCamt053(xml: string): ParsedStatement {
  if (!/BkToCstmrStmt/.test(xml)) throw new ValidationError('this is not a CAMT.053 statement');
  const stmts = allTags(xml, 'Stmt');
  if (!stmts.length) throw new ValidationError('the CAMT.053 file has no statement');
  const out: ParsedStatement = { format: 'camt053', lines: [] };
  for (const s of stmts) {
    const acct = tagText(s, ['Acct', 'Id', 'IBAN']) ?? tagText(s, ['Acct', 'Id', 'Othr', 'Id']);
    if (acct) {
      const a = acct.replace(/\s+/g, '');
      if (out.account && out.account !== a) throw new ValidationError('the file has statements of more than one account; download one account at a time');
      out.account = a;
    }
    out.reference ??= tagText(s, ['Id']);
    out.currency ??= tagText(s, ['Acct', 'Ccy']);
    for (const b of allTags(s, 'Bal')) {
      const code = tagText(b, ['Tp', 'CdOrPrtry', 'Cd']);
      const amt = Number(tagText(b, ['Amt']));
      const signed = (tagText(b, ['CdtDbtInd']) === 'DBIT' ? -1 : 1) * amt;
      if (code === 'OPBD' || code === 'PRCD') out.openingBalance ??= signed;
      if (code === 'CLBD') out.closingBalance = signed;
      out.currency ??= /<(?:\w+:)?Amt\b[^>]*Ccy="([A-Z]{3})"/.exec(b)?.[1];
    }
    for (const e of allTags(s, 'Ntry')) {
      const status = tagText(e, ['Sts', 'Cd']) ?? tagText(e, ['Sts']);
      if (status && status !== 'BOOK') continue;   // pending and information entries are not on the account yet
      const amt = Number(tagText(e, ['Amt']));
      if (!Number.isFinite(amt)) throw new ValidationError('a statement entry has no amount');
      let sign = tagText(e, ['CdtDbtInd']) === 'DBIT' ? -1 : 1;
      if (tagText(e, ['RvslInd']) === 'true') sign = -sign;
      const date = (tagText(e, ['BookgDt', 'Dt']) ?? tagText(e, ['BookgDt', 'DtTm']) ?? tagText(e, ['ValDt', 'Dt']) ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError('a statement entry has no booking date');
      const txs = allTags(e, 'TxDtls');
      const parties = txs.map((t) => (sign > 0 ? tagText(t, ['RltdPties', 'Dbtr', 'Nm']) ?? tagText(t, ['RltdPties', 'Dbtr', 'Pty', 'Nm']) : tagText(t, ['RltdPties', 'Cdtr', 'Nm']) ?? tagText(t, ['RltdPties', 'Cdtr', 'Pty', 'Nm']))).filter(Boolean);
      const info = [...txs.map((t) => allTags(t, 'Ustrd').join(' ')).filter(Boolean), tagText(e, ['AddtlNtryInf'])].filter(Boolean);
      const e2e = txs.map((t) => tagText(t, ['Refs', 'EndToEndId'])).find((r) => r && r !== 'NOTPROVIDED');
      out.lines.push({ date, amount: sign * amt, description: [...new Set(parties), ...info].join(' · ').slice(0, 500) || '(no description)',
        reference: e2e ?? tagText(e, ['AcctSvcrRef']) ?? undefined });
    }
  }
  return out;
}

/** Any statement file BAATS reads: CAMT.053, MT940 or CSV. */
export function parseStatementFile(text: string): ParsedStatement {
  const t = text.replace(/^﻿/, '');
  if (/^\s*</.test(t)) return parseCamt053(t);
  if (/(^|\n)\s*(\{[1-5]:|:20:|:25:|:60[FM]:)/.test(t)) return parseMt940(t);
  return { format: 'csv', lines: parseCsv(t) };
}

/**
 * Import a statement file into bank reconciliation. The ledger bank account is the one
 * named, or the one whose bank details carry the file's IBAN or account number.
 */
export async function importStatementFile(tx: Tx, ctx: Ctx, input: { companyId: string; bankAccount?: string; fileName?: string; text: string }) {
  const st = parseStatementFile(input.text);
  let accountRef = input.bankAccount;
  let details = null;
  if (st.account) {
    details = await one(tx, `SELECT d.*, a.code FROM fin.bank_details d JOIN fin.accounts a ON a.id = d.account_id
                              WHERE d.company_id = $1 AND (d.iban = $2 OR replace(d.account_no, ' ', '') = $2 OR $2 LIKE '%' || replace(d.account_no, ' ', ''))`,
    [input.companyId, st.account.toUpperCase()]);
    if (details && accountRef) {
      const named = await resolveAccount(tx, input.companyId, accountRef);
      if (named.id !== details.account_id) throw new ValidationError(`this statement is for ${st.account}, which is bank account ${details.code}, not ${named.code}`);
    }
    accountRef ??= details?.account_id;
  }
  if (!accountRef) {
    throw new ValidationError(st.account ? `no bank account in these books has the IBAN or number ${st.account}; add it under bank details, or choose the account` : 'choose the bank account this statement is for');
  }
  if (!details) {
    const acc = await resolveAccount(tx, input.companyId, accountRef);
    details = await one(tx, 'SELECT * FROM fin.bank_details WHERE account_id = $1', [acc.id]);
  }
  if (st.currency && details?.currency && st.currency !== details.currency) {
    throw new ValidationError(`the statement is in ${st.currency} but the bank account is in ${details.currency}`);
  }
  const r = await importStatement(tx, ctx, { companyId: input.companyId, bankAccount: accountRef, fileName: input.fileName,
    lines: st.lines.filter((l) => l.amount !== 0), closingBalance: st.closingBalance });
  await tx.query('UPDATE fin.bank_statements SET format = $2, opening_balance = $3, statement_ref = $4 WHERE id = $1',
    [r.statementId, st.format, st.openingBalance ?? null, st.reference?.slice(0, 100) ?? null]);
  return { ...r, format: st.format, account: st.account ?? null, openingBalance: st.openingBalance ?? null, closingBalance: st.closingBalance ?? null };
}

// --- Payment files -----------------------------------------------------------------------

const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
/** ISO 20022 text: the Latin set banks accept, at most n characters. */
const latin = (s: string, n: number) => s.normalize('NFKD').replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) || 'NOTPROVIDED';

/** Supplier payments on a bank account that are not in a payment file yet, with what the file needs. */
export async function payableForFile(tx: Tx, ctx: Ctx, companyId: string, bankAccount: string) {
  await authorize(tx, ctx, 'fin.payment.file', { unitId: companyId });
  const acc = await resolveAccount(tx, companyId, bankAccount);
  const rows = await many(tx, `SELECT p.id, p.no, p.date, p.amount::float AS amount, p.currency, p.reference, m.name AS supplier, m.code AS supplier_code,
        m.attributes->>'iban' AS iban, m.attributes->>'bic' AS bic
      FROM fin.payments p JOIN mdm.parties m ON m.id = p.party_id
     WHERE p.company_id = $1 AND p.bank_account_id = $2 AND p.kind = 'payment'
       AND NOT EXISTS (SELECT 1 FROM fin.payment_file_items i WHERE i.payment_id = p.id AND i.live)
     ORDER BY p.date, p.no`, [companyId, acc.id]);
  return rows.map((r) => {
    let problem: string | null = null;
    try { if (!r.iban) problem = 'the supplier has no IBAN'; else normalizeIban(r.iban); } catch (e) { problem = (e as Error).message; }
    return { ...r, problem };
  });
}

/**
 * A pain.001.001.03 credit transfer file for posted supplier payments, drawn on one
 * bank account. Each payment goes into one live file only. The file is kept as made.
 */
export async function createPaymentFile(tx: Tx, ctx: Ctx, input: { companyId: string; bankAccount: string; paymentIds: string[]; executionDate: string }) {
  await authorize(tx, ctx, 'fin.payment.file', { unitId: input.companyId });
  const c = await company(tx, input.companyId);
  const acc = await resolveAccount(tx, input.companyId, input.bankAccount);
  const bank = await one(tx, 'SELECT * FROM fin.bank_details WHERE account_id = $1', [acc.id]);
  if (!bank?.iban) throw new ValidationError(`bank account ${acc.code} has no IBAN in its bank details`);
  if (!input.paymentIds.length) throw new ValidationError('choose at least one payment');
  if (new Set(input.paymentIds).size !== input.paymentIds.length) throw new ValidationError('a payment is chosen twice');
  const open = new Map((await payableForFile(tx, ctx, input.companyId, input.bankAccount)).map((p) => [p.id, p]));
  const items = input.paymentIds.map((id) => {
    const p = open.get(id);
    if (!p) throw new ValidationError('a chosen payment is not a supplier payment on this account, or is already in a payment file');
    if (p.problem) throw new ValidationError(`${p.no} to ${p.supplier}: ${p.problem}`);
    if (p.currency !== bank.currency) throw new ValidationError(`${p.no} is in ${p.currency}, the account in ${bank.currency}`);
    return p;
  });
  const total = roundIn(bank.currency, items.reduce((s, p) => s + p.amount, 0));
  const no = await nextNumber(tx, input.companyId, 'payment_file', 'PF', input.executionDate);
  const msgId = `${no}-${randomUUID().slice(0, 8)}`.slice(0, 35);
  const now = new Date().toISOString().slice(0, 19);
  const amt = (n: number) => fixed(roundIn(bank.currency, n)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const agent = (bic: string | null) => bic ? `<FinInstnId><BIC>${bic}</BIC></FinInstnId>` : '<FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId>';
  const txs = items.map((p, i) => {
    const e2e = `${no}-${i + 1}`.slice(0, 35);
    return { p, e2e, xml: `
      <CdtTrfTxInf>
        <PmtId><InstrId>${xmlEsc(e2e)}</InstrId><EndToEndId>${xmlEsc(e2e)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="${bank.currency}">${amt(p.amount)}</InstdAmt></Amt>
        <CdtrAgt>${agent(p.bic ? p.bic.replace(/\s+/g, '').toUpperCase() : null)}</CdtrAgt>
        <Cdtr><Nm>${xmlEsc(latin(p.supplier, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${normalizeIban(p.iban)}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>${xmlEsc(latin(`${p.no}${p.reference ? ' ' + p.reference : ''}`, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>` };
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xmlEsc(msgId)}</MsgId>
      <CreDtTm>${now}</CreDtTm>
      <NbOfTxs>${items.length}</NbOfTxs>
      <CtrlSum>${amt(total)}</CtrlSum>
      <InitgPty><Nm>${xmlEsc(latin(c.legal_name, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xmlEsc(no)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>false</BtchBookg>
      <NbOfTxs>${items.length}</NbOfTxs>
      <CtrlSum>${amt(total)}</CtrlSum>
      <PmtTpInf><InstrPrty>NORM</InstrPrty></PmtTpInf>
      <ReqdExctnDt>${input.executionDate}</ReqdExctnDt>
      <Dbtr><Nm>${xmlEsc(latin(c.legal_name, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${bank.iban}</IBAN></Id><Ccy>${bank.currency}</Ccy></DbtrAcct>
      <DbtrAgt>${agent(bank.bic)}</DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>${txs.map((t) => t.xml).join('')}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
  const file = await one(tx, `INSERT INTO fin.payment_files (tenant_id, company_id, account_id, no, message_id, execution_date, payments, total, currency, xml, sha256, created_by)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, no, message_id, execution_date, payments, total, currency, status, created_at`,
  [input.companyId, acc.id, no, msgId, input.executionDate, items.length, total, bank.currency, xml, createHash('sha256').update(xml).digest('hex'), ctx.userId]);
  for (const t of txs) {
    await tx.query(`INSERT INTO fin.payment_file_items (tenant_id, file_id, payment_id, end_to_end_id, creditor_name, creditor_iban, creditor_bic, amount)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7)`, [file.id, t.p.id, t.e2e, t.p.supplier, normalizeIban(t.p.iban), t.p.bic ?? null, t.p.amount]);
  }
  return file;
}

export async function listPaymentFiles(tx: Tx, ctx: Ctx, companyId: string) {
  await authorize(tx, ctx, 'fin.payment.file', { unitId: companyId });
  return many(tx, `SELECT f.id, f.no, f.execution_date, f.payments, f.total::float AS total, f.currency, f.status, f.created_at, f.sent_at, a.code AS bank_account, u.email AS by
                     FROM fin.payment_files f JOIN fin.accounts a ON a.id = f.account_id LEFT JOIN iam.users u ON u.id = f.created_by
                    WHERE f.company_id = $1 ORDER BY f.created_at DESC LIMIT 100`, [companyId]);
}

export async function paymentFileXml(tx: Tx, ctx: Ctx, id: string) {
  const f = await one(tx, 'SELECT company_id, no, xml FROM fin.payment_files WHERE id = $1', [id]);
  if (!f) throw new NotFoundError('payment file');
  await authorize(tx, ctx, 'fin.payment.file', { unitId: f.company_id });
  return { name: `${f.no}.xml`, xml: f.xml as string };
}

/** Mark a file uploaded to the bank, or cancel one that was not (its payments can go in a new file). */
export async function setPaymentFileStatus(tx: Tx, ctx: Ctx, id: string, status: 'sent' | 'cancelled') {
  const f = await one(tx, 'SELECT * FROM fin.payment_files WHERE id = $1 FOR UPDATE', [id]);
  if (!f) throw new NotFoundError('payment file');
  await authorize(tx, ctx, 'fin.payment.file', { unitId: f.company_id });
  if (f.status !== 'created') throw new ConflictError(`payment file ${f.no} is already ${f.status}`);
  await tx.query(`UPDATE fin.payment_files SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`, [id, status]);
  if (status === 'cancelled') await tx.query('UPDATE fin.payment_file_items SET live = false WHERE file_id = $1', [id]);
  return { id, no: f.no, status };
}
