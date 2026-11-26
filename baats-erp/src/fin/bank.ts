import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from '../iam/authz.ts';
import { post, resolveAccount, round2 } from './ledger.ts';

/**
 * Bank statements and reconciliation (BAATS bankparse.js, re-implemented):
 *   import    a CSV statement (date, description, amount or debit/credit, reference);
 *             lines already imported are skipped by fingerprint
 *   match     each statement line to one ledger line on that bank account: automatically
 *             by amount within a few days (reference first), or by hand
 *   post      bank charges, interest and other items found only on the statement go to a
 *             chosen account (or 2900 Suspense) and are matched in the same step
 *   report    ledger balance, statement balance, and the items that explain the difference
 */

export interface StatementLine { date: string; description: string; amount: number; reference?: string }

function parseDate(s: string): string {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);           // UAE banks: day first
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = t.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{4})$/);
  if (m && months.includes(m[2].toLowerCase())) return `${m[3]}-${String(months.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new ValidationError(`cannot read the date "${s}"`);
}

function splitCsv(line: string, sep: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const money = (s: string | undefined) => {
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s.trim()) || /-$/.test(s.trim()) || /\bDR\b/i.test(s);
  const n = Number(s.replace(/[^0-9.\-]/g, '').replace(/-$/, ''));
  if (Number.isNaN(n)) throw new ValidationError(`cannot read the amount "${s}"`);
  return neg ? -Math.abs(n) : n;
};

/** Read a bank CSV. The header row names the columns; common bank wordings are recognised. */
export function parseCsv(text: string): StatementLine[] {
  const rows = text.replace(/^﻿/, '').split(/\r?\n/).filter((r) => r.trim());
  if (rows.length < 2) throw new ValidationError('the statement has no lines');
  const sep = (rows[0].match(/;/g)?.length ?? 0) > (rows[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const head = splitCsv(rows[0], sep).map((h) => h.toLowerCase());
  const col = (...names: RegExp[]) => head.findIndex((h) => names.some((n) => n.test(h)));
  const iDate = col(/^(transaction |txn |value |posting )?date/);
  const iDesc = col(/desc|narrat|detail|particular|memo/);
  const iAmt = col(/^amount/);
  const iDr = col(/debit|withdraw|money out|paid out/);
  const iCr = col(/credit|deposit|money in|paid in/);
  const iRef = col(/ref|cheque|check/);
  if (iDate < 0 || iDesc < 0 || (iAmt < 0 && (iDr < 0 || iCr < 0))) {
    throw new ValidationError('the header row needs Date, Description and either Amount or Debit and Credit columns');
  }
  return rows.slice(1).map((r) => {
    const c = splitCsv(r, sep);
    const amount = iAmt >= 0 ? money(c[iAmt]) : round2(money(c[iCr]) - Math.abs(money(c[iDr])));
    return { date: parseDate(c[iDate]), description: c[iDesc] || '(no description)', amount: round2(amount), reference: iRef >= 0 ? c[iRef] || undefined : undefined };
  }).filter((l) => l.amount !== 0);
}

async function bankAccount(tx: Tx, companyId: string, ref: string) {
  const a = await resolveAccount(tx, companyId, ref);
  const full = await one(tx, 'SELECT * FROM fin.accounts WHERE id = $1', [a.id]);
  if (!['cash', 'bank'].includes(full.system_role ?? '') && !full.code.startsWith('10')) throw new ValidationError(`${full.code} is not a cash or bank account`);
  return full;
}

export async function importStatement(tx: Tx, ctx: Ctx, input: { companyId: string; bankAccount: string; fileName?: string; csv?: string; lines?: StatementLine[]; closingBalance?: number }) {
  await authorize(tx, ctx, 'fin.bank.reconcile', { unitId: input.companyId });
  const acc = await bankAccount(tx, input.companyId, input.bankAccount);
  const lines = input.lines ?? parseCsv(input.csv ?? '');
  if (!lines.length) throw new ValidationError('the statement has no lines');
  const dates = lines.map((l) => l.date).sort();
  const st = await one(tx, `INSERT INTO fin.bank_statements (tenant_id, company_id, account_id, file_name, date_from, date_to, closing_balance, imported_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.companyId, acc.id, input.fileName ?? null, dates[0], dates[dates.length - 1], input.closingBalance ?? null, ctx.userId]);
  let added = 0, skipped = 0;
  for (const l of lines) {
    const fp = [l.date, round2(l.amount).toFixed(2), l.description.trim().toLowerCase(), (l.reference ?? '').trim().toLowerCase()].join('|');
    const dup = await one(tx, `SELECT 1 FROM fin.bank_lines b JOIN fin.bank_statements s ON s.id = b.statement_id
                                WHERE s.account_id = $1 AND b.fingerprint = $2`, [acc.id, fp]);
    if (dup) { skipped++; continue; }
    added++;
    await tx.query(`INSERT INTO fin.bank_lines (tenant_id, statement_id, line_no, date, description, reference, amount, fingerprint)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7)`, [st.id, added, l.date, l.description, l.reference ?? null, round2(l.amount), fp]);
  }
  const auto = await autoMatch(tx, ctx, input.companyId, acc.id);
  return { statementId: st.id, added, skipped, autoMatched: auto };
}

/** Ledger lines on the bank account not reconciled yet: + money in. */
async function openLedgerLines(tx: Tx, accountId: string) {
  return many(tx, `SELECT l.id, j.date, j.no, j.memo, l.description, (l.debit - l.credit)::float AS amount
                     FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted'
                    WHERE l.account_id = $1 AND NOT EXISTS (SELECT 1 FROM fin.bank_lines b WHERE b.journal_line_id = l.id)
                    ORDER BY j.date, j.no`, [accountId]);
}

/** Match unmatched statement lines to ledger lines of the same amount within 5 days; a reference match wins. */
export async function autoMatch(tx: Tx, ctx: Ctx, companyId: string, accountId: string): Promise<number> {
  const open = await openLedgerLines(tx, accountId);
  const lines = await many(tx, `SELECT b.* FROM fin.bank_lines b JOIN fin.bank_statements s ON s.id = b.statement_id
                                 WHERE s.account_id = $1 AND b.status = 'unmatched' ORDER BY b.date, b.line_no`, [accountId]);
  const used = new Set<string>();
  const DAY = 86_400_000;
  let n = 0;
  for (const b of lines) {
    const amt = Number(b.amount), when = b.date.getTime();
    const cands = open.filter((l) => !used.has(l.id) && round2(l.amount) === amt && Math.abs(l.date.getTime() - when) <= 5 * DAY);
    if (!cands.length) continue;
    const ref = String(b.reference ?? '').toLowerCase();
    const best = (ref && cands.find((l) => `${l.no} ${l.memo} ${l.description ?? ''}`.toLowerCase().includes(ref)))
      || (cands.length === 1 ? cands[0] : cands.sort((x, y) => Math.abs(x.date.getTime() - when) - Math.abs(y.date.getTime() - when))[0]);
    used.add(best.id);
    await tx.query(`UPDATE fin.bank_lines SET status = 'matched', journal_line_id = $2, matched_by = $3, matched_at = now() WHERE id = $1`, [b.id, best.id, ctx.userId]);
    n++;
  }
  void companyId;
  return n;
}

async function statementLine(tx: Tx, ctx: Ctx, id: string) {
  const b = await one(tx, `SELECT b.*, s.company_id, s.account_id FROM fin.bank_lines b JOIN fin.bank_statements s ON s.id = b.statement_id WHERE b.id = $1 FOR UPDATE OF b`, [id]);
  if (!b) throw new NotFoundError('statement line');
  await authorize(tx, ctx, 'fin.bank.reconcile', { unitId: b.company_id });
  return b;
}

export async function matchLine(tx: Tx, ctx: Ctx, bankLineId: string, journalLineId: string) {
  const b = await statementLine(tx, ctx, bankLineId);
  if (b.status === 'matched') throw new ConflictError('the statement line is already matched');
  const l = await one(tx, `SELECT l.*, j.status FROM fin.journal_lines l JOIN fin.journals j ON j.id = l.journal_id WHERE l.id = $1`, [journalLineId]);
  if (!l || l.account_id !== b.account_id || l.status !== 'posted') throw new ValidationError('choose a posted ledger line on the same bank account');
  if (round2(Number(l.debit) - Number(l.credit)) !== Number(b.amount)) throw new ValidationError('the amounts differ; post the difference (for example bank charges) as its own line');
  await tx.query(`UPDATE fin.bank_lines SET status = 'matched', journal_line_id = $2, matched_by = $3, matched_at = now() WHERE id = $1`, [bankLineId, journalLineId, ctx.userId]);
  return { matched: true };
}

export async function unmatchLine(tx: Tx, ctx: Ctx, bankLineId: string) {
  const b = await statementLine(tx, ctx, bankLineId);
  if (b.status !== 'matched') throw new ConflictError('the statement line is not matched');
  await tx.query(`UPDATE fin.bank_lines SET status = 'unmatched', journal_line_id = NULL, matched_by = NULL, matched_at = NULL WHERE id = $1`, [bankLineId]);
  return { matched: false };
}

/** Post an item seen only on the statement (charges, interest, unknown receipts) and match it. */
export async function postStatementLine(tx: Tx, ctx: Ctx, bankLineId: string, input: { account?: string; memo?: string; taxCode?: string }) {
  const b = await statementLine(tx, ctx, bankLineId);
  if (b.status === 'matched') throw new ConflictError('the statement line is already matched');
  const other = await resolveAccount(tx, b.company_id, input.account ?? 'role:suspense');
  const full = await one(tx, 'SELECT control, system_role FROM fin.accounts WHERE id = $1', [other.id]);
  if (full.control) throw new ValidationError('customer and supplier money goes through receipts and payments, not here');
  const amt = Number(b.amount);
  const date = b.date.toISOString().slice(0, 10);
  const j = await post(tx, ctx, { companyId: b.company_id, type: 'bank', date, memo: input.memo ?? b.description, source: { type: 'bank_line', id: b.id },
    lines: amt > 0
      ? [{ account: b.account_id, debit: amt, description: b.description }, { account: other.id, credit: amt, description: b.description }]
      : [{ account: other.id, debit: -amt, description: b.description }, { account: b.account_id, credit: -amt, description: b.description }] });
  const line = await one(tx, 'SELECT id FROM fin.journal_lines WHERE journal_id = $1 AND account_id = $2', [j.id, b.account_id]);
  await tx.query(`UPDATE fin.bank_lines SET status = 'matched', journal_line_id = $2, matched_by = $3, matched_at = now() WHERE id = $1`, [bankLineId, line.id, ctx.userId]);
  return { journalId: j.id, no: j.no };
}

/** Bank reconciliation: why the ledger and the bank differ at a date. */
export async function reconciliation(tx: Tx, ctx: Ctx, companyId: string, bankAccountRef: string, asOf: string) {
  await authorize(tx, ctx, 'fin.bank.reconcile', { unitId: companyId });
  const acc = await bankAccount(tx, companyId, bankAccountRef);
  const ledger = await one(tx, `SELECT coalesce(sum(l.debit - l.credit), 0)::float AS b FROM fin.journal_lines l
                                  JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' WHERE l.account_id = $1 AND j.date <= $2`, [acc.id, asOf]);
  const statement = await one(tx, `SELECT coalesce(sum(b.amount), 0)::float AS s, count(*)::int AS n FROM fin.bank_lines b
                                     JOIN fin.bank_statements s ON s.id = b.statement_id WHERE s.account_id = $1 AND b.date <= $2`, [acc.id, asOf]);
  const lastClosing = await one(tx, `SELECT closing_balance FROM fin.bank_statements WHERE account_id = $1 AND date_to <= $2 AND closing_balance IS NOT NULL
                                     ORDER BY date_to DESC, imported_at DESC LIMIT 1`, [acc.id, asOf]);
  const inLedgerOnly = (await openLedgerLines(tx, acc.id)).filter((l) => l.date.toISOString().slice(0, 10) <= asOf);
  const onStatementOnly = await many(tx, `SELECT b.id, b.date, b.description, b.reference, b.amount::float AS amount FROM fin.bank_lines b
                                            JOIN fin.bank_statements s ON s.id = b.statement_id
                                           WHERE s.account_id = $1 AND b.status = 'unmatched' AND b.date <= $2 ORDER BY b.date, b.line_no`, [acc.id, asOf]);
  const outstanding = round2(inLedgerOnly.reduce((x, l) => x + l.amount, 0));
  const unrecorded = round2(onStatementOnly.reduce((x, l) => x + l.amount, 0));
  return {
    account: { code: acc.code, name: acc.name }, asOf,
    ledgerBalance: round2(ledger.b),
    statementMovements: round2(statement.s), statementLines: statement.n,
    statementClosingBalance: lastClosing ? Number(lastClosing.closing_balance) : null,
    outstandingInLedger: outstanding, notYetInLedger: unrecorded,
    // Ledger + items only on the statement - items only in the ledger = what the bank shows.
    adjustedBalance: round2(ledger.b + unrecorded - outstanding),
    inLedgerOnly, onStatementOnly,
  };
}

export async function listStatementLines(tx: Tx, ctx: Ctx, companyId: string, bankAccountRef: string, status?: string) {
  await authorize(tx, ctx, 'fin.bank.reconcile', { unitId: companyId });
  const acc = await bankAccount(tx, companyId, bankAccountRef);
  return many(tx, `SELECT b.id, b.date, b.description, b.reference, b.amount::float AS amount, b.status, j.no AS matched_journal
                     FROM fin.bank_lines b JOIN fin.bank_statements s ON s.id = b.statement_id
                     LEFT JOIN fin.journal_lines l ON l.id = b.journal_line_id LEFT JOIN fin.journals j ON j.id = l.journal_id
                    WHERE s.account_id = $1 AND ($2::text IS NULL OR b.status = $2) ORDER BY b.date DESC, b.line_no`, [acc.id, status ?? null]);
}
