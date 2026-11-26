import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, unitScope } from '../iam/authz.ts';
import { createParty } from '../mdm/service.ts';

/**
 * CRM: leads -> qualified -> converted to a customer (through master data, so the
 * customer still goes through its activation approval) and an opportunity; the
 * opportunity pipeline feeds quotations in sales. Everything is scoped to the
 * owning org unit, so a sales team sees its own pipeline.
 */

const STAGE_PROBABILITY: Record<string, number> = { prospecting: 10, qualification: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 };

export async function createLead(tx: Tx, ctx: Ctx, input: { ownerUnitId: string; name: string; companyName?: string; email?: string; phone?: string; countryCode?: string; source?: string; notes?: string }) {
  await authorize(tx, ctx, 'crm.manage', { unitId: input.ownerUnitId });
  return one(tx, `INSERT INTO crm.leads (tenant_id, owner_unit_id, owner_user_id, name, company_name, email, phone, country_code, source, notes)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [input.ownerUnitId, ctx.userId, input.name, input.companyName ?? null, input.email ?? null, input.phone ?? null,
      input.countryCode ?? null, input.source ?? null, input.notes ?? null]);
}

async function lead(tx: Tx, ctx: Ctx, id: string) {
  const l = await one(tx, 'SELECT * FROM crm.leads WHERE id = $1 FOR UPDATE', [id]);
  if (!l) throw new NotFoundError('lead');
  await authorize(tx, ctx, 'crm.manage', { unitId: l.owner_unit_id });
  return l;
}

export async function setLeadStatus(tx: Tx, ctx: Ctx, id: string, status: 'qualified' | 'disqualified') {
  const l = await lead(tx, ctx, id);
  if (l.status === 'converted') throw new ConflictError('the lead is already converted');
  return one(tx, 'UPDATE crm.leads SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
}

/** Turn a lead into a draft customer and, optionally, an opportunity. */
export async function convertLead(tx: Tx, ctx: Ctx, id: string, input: { customerCode: string; countryCode?: string; opportunity?: { title: string; amount: number; currency: string; expectedClose?: string } }) {
  const l = await lead(tx, ctx, id);
  if (l.status === 'converted') throw new ConflictError('the lead is already converted');
  if (l.status === 'disqualified') throw new ConflictError('a disqualified lead cannot be converted');
  const country = input.countryCode ?? l.country_code;
  if (!country) throw new ValidationError('give the customer\'s country');
  const { party, possibleDuplicates } = await createParty(tx, ctx, {
    code: input.customerCode, name: l.company_name ?? l.name, isCustomer: true, countryCode: country, ownerUnitId: l.owner_unit_id,
    attributes: { contact_name: l.name, email: l.email, phone: l.phone, lead_id: l.id },
  });
  await tx.query(`UPDATE crm.leads SET status = 'converted', party_id = $2 WHERE id = $1`, [id, party.id]);
  await tx.query(`UPDATE crm.opportunities SET party_id = $2 WHERE lead_id = $1 AND party_id IS NULL`, [id, party.id]);
  const opportunity = input.opportunity
    ? await createOpportunity(tx, ctx, { ownerUnitId: l.owner_unit_id, leadId: id, partyId: party.id, ...input.opportunity })
    : null;
  return { party, possibleDuplicates, opportunity };
}

export async function listLeads(tx: Tx, ctx: Ctx, status?: string) {
  const s = await unitScope(tx, ctx.userId!, 'crm.manage', 'l.owner_unit_id', 2);
  return many(tx, `SELECT l.* FROM crm.leads l WHERE ($1::text IS NULL OR l.status = $1) AND ${s.sql} ORDER BY l.created_at DESC`,
    [status ?? null, s.param]);
}

export async function createOpportunity(tx: Tx, ctx: Ctx, input: { ownerUnitId: string; title: string; amount: number; currency: string; leadId?: string; partyId?: string; expectedClose?: string; stage?: string }) {
  await authorize(tx, ctx, 'crm.manage', { unitId: input.ownerUnitId });
  if (!input.leadId && !input.partyId) throw new ValidationError('an opportunity needs a lead or a customer');
  const stage = input.stage ?? 'prospecting';
  return one(tx, `INSERT INTO crm.opportunities (tenant_id, owner_unit_id, owner_user_id, lead_id, party_id, title, stage, amount, currency, probability, expected_close)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [input.ownerUnitId, ctx.userId, input.leadId ?? null, input.partyId ?? null, input.title, stage, input.amount, input.currency,
      STAGE_PROBABILITY[stage] ?? 10, input.expectedClose ?? null]);
}

export async function updateOpportunity(tx: Tx, ctx: Ctx, id: string, patch: { stage?: string; amount?: number; probability?: number; expectedClose?: string; lostReason?: string }) {
  const o = await one(tx, 'SELECT * FROM crm.opportunities WHERE id = $1 FOR UPDATE', [id]);
  if (!o) throw new NotFoundError('opportunity');
  await authorize(tx, ctx, 'crm.manage', { unitId: o.owner_unit_id });
  if (['won', 'lost'].includes(o.stage)) throw new ConflictError(`the opportunity is already ${o.stage}`);
  if (patch.stage === 'lost' && !patch.lostReason) throw new ValidationError('say why the opportunity was lost');
  if (patch.stage === 'won' && !o.party_id) throw new ValidationError('convert the lead to a customer before marking the opportunity won');
  const stage = patch.stage ?? o.stage;
  const probability = patch.probability ?? (patch.stage ? STAGE_PROBABILITY[patch.stage] : o.probability);
  return one(tx, `UPDATE crm.opportunities SET stage = $2, amount = $3, probability = $4, expected_close = $5, lost_reason = $6 WHERE id = $1 RETURNING *`,
    [id, stage, patch.amount ?? o.amount, probability, patch.expectedClose ?? o.expected_close, patch.lostReason ?? o.lost_reason]);
}

/** Pipeline by stage, with the probability-weighted value. */
export async function pipeline(tx: Tx, ctx: Ctx) {
  const s = await unitScope(tx, ctx.userId!, 'crm.manage', 'o.owner_unit_id', 1);
  const stages = await many(tx, `SELECT o.stage, o.currency, count(*)::int AS count, sum(o.amount)::float AS amount,
                                        sum(o.amount * o.probability / 100.0)::float AS weighted
                                   FROM crm.opportunities o WHERE ${s.sql} GROUP BY o.stage, o.currency`, [s.param]);
  const list = await many(tx, `SELECT o.*, coalesce(p.name, l.company_name, l.name) AS customer FROM crm.opportunities o
                                 LEFT JOIN mdm.parties p ON p.id = o.party_id LEFT JOIN crm.leads l ON l.id = o.lead_id
                                WHERE ${s.sql} ORDER BY o.expected_close NULLS LAST, o.created_at`, [s.param]);
  const order = Object.keys(STAGE_PROBABILITY);
  stages.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
  return { stages, opportunities: list };
}

async function entityUnit(tx: Tx, type: string, id: string): Promise<string> {
  const sql = type === 'lead' ? 'SELECT owner_unit_id AS u FROM crm.leads WHERE id = $1'
    : type === 'opportunity' ? 'SELECT owner_unit_id AS u FROM crm.opportunities WHERE id = $1'
      : 'SELECT owner_unit_id AS u FROM mdm.parties WHERE id = $1';
  const r = await one(tx, sql, [id]);
  if (!r) throw new NotFoundError(type);
  return r.u;
}

export async function addActivity(tx: Tx, ctx: Ctx, input: { entityType: 'lead' | 'opportunity' | 'party'; entityId: string; kind: string; subject: string; dueAt?: string; done?: boolean }) {
  await authorize(tx, ctx, 'crm.manage', { unitId: await entityUnit(tx, input.entityType, input.entityId) });
  return one(tx, `INSERT INTO crm.activities (tenant_id, entity_type, entity_id, kind, subject, due_at, done_at, user_id)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.entityType, input.entityId, input.kind, input.subject, input.dueAt ?? null, input.done ? new Date() : null, ctx.userId]);
}

export async function completeActivity(tx: Tx, ctx: Ctx, id: string) {
  const a = await one(tx, 'SELECT * FROM crm.activities WHERE id = $1', [id]);
  if (!a) throw new NotFoundError('activity');
  await authorize(tx, ctx, 'crm.manage', { unitId: await entityUnit(tx, a.entity_type, a.entity_id) });
  return one(tx, 'UPDATE crm.activities SET done_at = now() WHERE id = $1 RETURNING *', [id]);
}

export async function activities(tx: Tx, ctx: Ctx, entityType: string, entityId: string) {
  await authorize(tx, ctx, 'crm.manage', { unitId: await entityUnit(tx, entityType, entityId) });
  return many(tx, 'SELECT * FROM crm.activities WHERE entity_type = $1 AND entity_id = $2 ORDER BY coalesce(due_at, created_at)', [entityType, entityId]);
}
