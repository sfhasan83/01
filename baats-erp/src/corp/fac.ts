import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, decide } from '../iam/authz.ts';

/**
 * Facilities: rooms, desks, offices and parking per site, and bookings. Anyone
 * can book a bookable space; double bookings are refused (the space row is
 * locked while checking), and the attendees must fit. Facility faults are raised
 * as service desk tickets in the facilities queue, pointing at the space.
 */

export async function createSpace(tx: Tx, ctx: Ctx, input: { unitId: string; code: string; name: string; kind: string; capacity?: number; bookable?: boolean }) {
  await authorize(tx, ctx, 'fac.manage', { unitId: input.unitId });
  return one(tx, `INSERT INTO fac.spaces (tenant_id, unit_id, code, name, kind, capacity, bookable) VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.unitId, input.code, input.name, input.kind, input.capacity ?? 1, input.bookable ?? true]);
}

export async function listSpaces(tx: Tx) {
  return many(tx, `SELECT s.*, u.code AS site_code, u.name AS site_name FROM fac.spaces s JOIN org.units u ON u.id = s.unit_id
                    WHERE s.status = 'active' ORDER BY u.code, s.kind, s.code`);
}

export async function book(tx: Tx, ctx: Ctx, input: { spaceId: string; startsAt: string; endsAt: string; purpose: string; attendees?: number }) {
  if (!ctx.userId) throw new ForbiddenError('fac.book', {}, 'sign in to book');
  const s = await one(tx, 'SELECT * FROM fac.spaces WHERE id = $1 FOR UPDATE', [input.spaceId]);
  if (!s || s.status !== 'active') throw new NotFoundError('space');
  if (!s.bookable) throw new ValidationError(`${s.name} cannot be booked`);
  const from = new Date(input.startsAt), to = new Date(input.endsAt);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new ValidationError('the booking must end after it starts');
  if (to.getTime() - from.getTime() > 12 * 3600e3) throw new ValidationError('bookings are limited to 12 hours');
  const attendees = input.attendees ?? 1;
  if (attendees > s.capacity) throw new ValidationError(`${s.name} holds ${s.capacity}`);
  const clash = await one(tx, `SELECT b.starts_at, b.ends_at, u.display_name FROM fac.bookings b JOIN iam.users u ON u.id = b.booked_by
                                WHERE b.space_id = $1 AND b.status = 'booked' AND b.starts_at < $3 AND b.ends_at > $2 LIMIT 1`, [s.id, from, to]);
  if (clash) throw new ConflictError(`${s.name} is already booked by ${clash.display_name} from ${clash.starts_at.toISOString().slice(11, 16)} to ${clash.ends_at.toISOString().slice(11, 16)} UTC`);
  return one(tx, `INSERT INTO fac.bookings (tenant_id, space_id, booked_by, starts_at, ends_at, purpose, attendees) VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING *`,
    [s.id, ctx.userId, from, to, input.purpose, attendees]);
}

export async function cancelBooking(tx: Tx, ctx: Ctx, id: string) {
  const b = await one(tx, 'SELECT b.*, s.unit_id FROM fac.bookings b JOIN fac.spaces s ON s.id = b.space_id WHERE b.id = $1 FOR UPDATE OF b', [id]);
  if (!b) throw new NotFoundError('booking');
  if (b.booked_by !== ctx.userId && !(await decide(tx, ctx.userId!, 'fac.manage', { unitId: b.unit_id })).allowed) {
    throw new ForbiddenError('fac.manage', { unitId: b.unit_id }, 'only whoever booked it or facilities can cancel');
  }
  if (b.status === 'cancelled') throw new ConflictError('already cancelled');
  return one(tx, `UPDATE fac.bookings SET status = 'cancelled' WHERE id = $1 RETURNING *`, [id]);
}

/** Bookings on a day (UTC), all spaces or one. */
export async function bookings(tx: Tx, date: string, spaceId?: string) {
  return many(tx, `SELECT b.*, s.code AS space_code, s.name AS space_name, u.display_name AS booked_by_name
                     FROM fac.bookings b JOIN fac.spaces s ON s.id = b.space_id JOIN iam.users u ON u.id = b.booked_by
                    WHERE b.status = 'booked' AND b.starts_at < $1::date + 1 AND b.ends_at > $1::date AND ($2::uuid IS NULL OR b.space_id = $2)
                    ORDER BY s.code, b.starts_at`, [date, spaceId ?? null]);
}

/** Share of bookable hours used per space over a period (08:00 to 18:00, Sunday to Thursday or Monday to Friday counted as 5 days a week). */
export async function utilisation(tx: Tx, ctx: Ctx, unitId: string, from: string, to: string) {
  await authorize(tx, ctx, 'fac.manage', { unitId });
  const days = Math.max(1, Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400e3) + 1);
  const available = Math.round(days * 5 / 7) * 10;
  return (await many(tx, `SELECT s.code, s.name, s.kind, coalesce(sum(extract(epoch FROM b.ends_at - b.starts_at) / 3600), 0)::float AS booked_hours, count(b.id)::int AS bookings
      FROM fac.spaces s JOIN org.units u ON u.id = s.unit_id LEFT JOIN fac.bookings b ON b.space_id = s.id AND b.status = 'booked' AND b.starts_at >= $2::date AND b.starts_at < $3::date + 1
     WHERE u.path LIKE (SELECT path FROM org.units WHERE id = $1) || '%' AND s.bookable GROUP BY s.code, s.name, s.kind ORDER BY s.code`, [unitId, from, to]))
    .map((r) => ({ ...r, availableHours: available, utilisationPct: available ? Math.round(r.booked_hours / available * 1000) / 10 : 0 }));
}
