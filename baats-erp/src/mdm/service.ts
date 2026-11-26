import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, unitScope } from '../iam/authz.ts';
import { onWorkflowComplete, submit } from '../workflow/engine.ts';

/**
 * Master data engine (Phase 1 scope): units of measure, items, and business
 * partners (customers and suppliers). A partner is created as a draft and becomes
 * usable only after approval through the workflow engine, so every downstream
 * module (sales, procurement, finance) sees one governed record.
 */

export const PARTY_WORKFLOW = 'mdm.party.activation';

export function normalizeName(name: string): string {
  return name.toLowerCase()
    .replace(/\b(llc|l\.l\.c|ltd|limited|inc|corp|co|fze|fzco|plc|pvt|gmbh|sa|est|trading)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// --- Units of measure and items ------------------------------------------------

export async function createUom(tx: Tx, ctx: Ctx, input: { code: string; name: string }) {
  await authorize(tx, ctx, 'mdm.uom.manage');
  return one(tx, 'INSERT INTO mdm.uoms (tenant_id, code, name) VALUES (app.tenant(), $1, $2) RETURNING *', [input.code, input.name]);
}

export async function listUoms(tx: Tx) {
  return many(tx, 'SELECT * FROM mdm.uoms ORDER BY code');
}

export async function createItem(tx: Tx, ctx: Ctx, input: { code: string; name: string; itemType: string; baseUom: string; barcode?: string; attributes?: Record<string, unknown> }) {
  await authorize(tx, ctx, 'mdm.item.manage');
  const uom = await one(tx, 'SELECT id FROM mdm.uoms WHERE code = $1', [input.baseUom]);
  if (!uom) throw new ValidationError(`unknown unit of measure ${input.baseUom}`);
  return one(tx, `INSERT INTO mdm.items (tenant_id, code, name, item_type, base_uom_id, barcode, attributes)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.code, input.name, input.itemType, uom.id, input.barcode ?? null, JSON.stringify(input.attributes ?? {})]);
}

export async function listItems(tx: Tx, ctx: Ctx, q?: string) {
  await authorize(tx, ctx, 'mdm.item.read');
  return many(tx, `SELECT i.*, u.code AS base_uom FROM mdm.items i JOIN mdm.uoms u ON u.id = i.base_uom_id
                    WHERE $1::text IS NULL OR i.code ILIKE '%' || $1 || '%' OR i.name ILIKE '%' || $1 || '%' OR i.barcode = $1
                    ORDER BY i.code LIMIT 200`, [q ?? null]);
}

// --- Business partners --------------------------------------------------------

export interface PartyInput {
  code: string; name: string; isCustomer?: boolean; isSupplier?: boolean; countryCode: string; currencyCode?: string;
  taxRegistrationNo?: string; creditLimit?: number; ownerUnitId: string; attributes?: Record<string, unknown>;
}

/** Create a draft partner. Returns likely duplicates as warnings; the caller decides. */
export async function createParty(tx: Tx, ctx: Ctx, input: PartyInput) {
  await authorize(tx, ctx, 'mdm.party.manage', { unitId: input.ownerUnitId });
  const country = await one(tx, 'SELECT currency_code FROM ref.countries WHERE code = $1', [input.countryCode]);
  if (!country) throw new ValidationError(`unsupported country ${input.countryCode}`);
  const normalized = normalizeName(input.name);
  const duplicates = await many(tx, `SELECT id, code, name, status FROM mdm.parties WHERE normalized_name = $1`, [normalized]);
  const party = await one(tx, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_customer, is_supplier,
      country_code, currency_code, tax_registration_no, credit_limit, owner_unit_id, attributes)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [input.code, input.name, normalized, input.isCustomer ?? false, input.isSupplier ?? false, input.countryCode,
      input.currencyCode ?? country.currency_code, input.taxRegistrationNo ?? null, input.creditLimit ?? null,
      input.ownerUnitId, JSON.stringify(input.attributes ?? {})]);
  return { party, possibleDuplicates: duplicates };
}

/** Send a draft (or rejected) partner for approval. */
export async function submitParty(tx: Tx, ctx: Ctx, partyId: string) {
  const p = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1 FOR UPDATE', [partyId]);
  if (!p) throw new NotFoundError('party');
  await authorize(tx, ctx, 'mdm.party.manage', { unitId: p.owner_unit_id });
  if (!['draft', 'rejected'].includes(p.status)) throw new ConflictError(`party is ${p.status}`);
  await tx.query(`UPDATE mdm.parties SET status = 'pending_approval' WHERE id = $1`, [partyId]);
  // The payload is what approval rules and approval limits are evaluated against.
  return submit(tx, ctx, {
    code: PARTY_WORKFLOW, entityType: 'mdm.party', entityId: partyId, subjectUnitId: p.owner_unit_id,
    payload: {
      code: p.code, name: p.name, country: p.country_code, currency: p.currency_code,
      is_customer: p.is_customer, is_supplier: p.is_supplier,
      credit_limit: p.credit_limit === null ? 0 : Number(p.credit_limit),
    },
  });
}

onWorkflowComplete('mdm.party', async (tx, inst) => {
  const status = inst.status === 'approved' ? 'active' : inst.status === 'rejected' ? 'rejected' : 'draft';
  await tx.query('UPDATE mdm.parties SET status = $2 WHERE id = $1', [inst.entity_id, status]);
});

export async function updateParty(tx: Tx, ctx: Ctx, partyId: string, patch: { name?: string; creditLimit?: number; taxRegistrationNo?: string }) {
  const p = await one(tx, 'SELECT * FROM mdm.parties WHERE id = $1 FOR UPDATE', [partyId]);
  if (!p) throw new NotFoundError('party');
  await authorize(tx, ctx, 'mdm.party.manage', { unitId: p.owner_unit_id });
  if (p.status === 'pending_approval') throw new ConflictError('party is waiting for approval');
  // A change to a governed field sends an active partner back through approval.
  const governed = patch.creditLimit !== undefined || patch.taxRegistrationNo !== undefined;
  const status = p.status === 'active' && governed ? 'draft' : p.status;
  return one(tx, `UPDATE mdm.parties SET name = coalesce($2, name), normalized_name = coalesce($3, normalized_name),
                    credit_limit = coalesce($4, credit_limit), tax_registration_no = coalesce($5, tax_registration_no), status = $6
                   WHERE id = $1 RETURNING *`,
    [partyId, patch.name ?? null, patch.name ? normalizeName(patch.name) : null, patch.creditLimit ?? null,
      patch.taxRegistrationNo ?? null, status]);
}

export async function setPartyBlocked(tx: Tx, ctx: Ctx, partyId: string, blocked: boolean) {
  const p = await one(tx, 'SELECT owner_unit_id, status FROM mdm.parties WHERE id = $1', [partyId]);
  if (!p) throw new NotFoundError('party');
  await authorize(tx, ctx, 'mdm.party.approve', { unitId: p.owner_unit_id });
  if (blocked ? p.status !== 'active' : p.status !== 'blocked') throw new ConflictError(`party is ${p.status}`);
  return one(tx, 'UPDATE mdm.parties SET status = $2 WHERE id = $1 RETURNING *', [partyId, blocked ? 'blocked' : 'active']);
}

export async function listParties(tx: Tx, ctx: Ctx, filter: { status?: string; type?: 'customer' | 'supplier' } = {}) {
  const scope = await unitScope(tx, ctx.userId!, 'mdm.party.read', 'p.owner_unit_id', 1);
  return many(tx, `SELECT p.* FROM mdm.parties p
                    WHERE ${scope.sql} AND ($2::text IS NULL OR p.status = $2)
                      AND ($3::text IS NULL OR ($3 = 'customer' AND p.is_customer) OR ($3 = 'supplier' AND p.is_supplier))
                    ORDER BY p.code`, [scope.param, filter.status ?? null, filter.type ?? null]);
}
