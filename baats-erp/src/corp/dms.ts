import { createHash } from 'node:crypto';
import { NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, unitScope } from '../iam/authz.ts';

/**
 * Document management. A document belongs to an org unit (that is who may read
 * it), can be attached to any record (a contract, an audit finding, an incident,
 * an asset...), and keeps every version it ever had: versions are append-only
 * and carry a SHA-256 of their bytes. Confidential documents also need
 * dms.confidential. Nothing is deleted:
 * the retention date records how long the organization must keep the file.
 */

export const MAX_BYTES = 10 * 1024 * 1024;

function decode(b64: string): Buffer {
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length && b64.length) throw new ValidationError('the file is not valid base64');
  if (buf.length > MAX_BYTES) throw new ValidationError('files are limited to 10 MB');
  return buf;
}

async function writeVersion(tx: Tx, ctx: Ctx, documentId: string, version: number, f: { fileName: string; contentType?: string; contentBase64: string; note?: string }) {
  const buf = decode(f.contentBase64);
  const sha = createHash('sha256').update(buf).digest('hex');
  await tx.query(`INSERT INTO dms.versions (tenant_id, document_id, version, file_name, content_type, size_bytes, sha256, content, note, uploaded_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [documentId, version, f.fileName, f.contentType || 'application/octet-stream', buf.length, sha, buf, f.note ?? null, ctx.userId]);
  await tx.query('UPDATE dms.documents SET current_version = $2 WHERE id = $1', [documentId, version]);
  return sha;
}

export interface UploadInput {
  unitId: string; title: string; category?: string; entityType?: string; entityId?: string; confidential?: boolean; retainUntil?: string;
  fileName: string; contentType?: string; contentBase64: string; note?: string;
}

export async function uploadDocument(tx: Tx, ctx: Ctx, input: UploadInput) {
  await authorize(tx, ctx, 'dms.manage', { unitId: input.unitId });
  if (!!input.entityType !== !!input.entityId) throw new ValidationError('give both the record type and its id, or neither');
  const d = await one(tx, `INSERT INTO dms.documents (tenant_id, unit_id, title, category, entity_type, entity_id, confidential, retain_until, created_by)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [input.unitId, input.title, input.category ?? 'general', input.entityType ?? null, input.entityId ?? null, input.confidential ?? false, input.retainUntil ?? null, ctx.userId]);
  await writeVersion(tx, ctx, d.id, 1, input);
  return detail(tx, d.id);
}

async function readable(tx: Tx, ctx: Ctx, id: string) {
  const d = await one(tx, 'SELECT * FROM dms.documents WHERE id = $1', [id]);
  if (!d) throw new NotFoundError('document');
  await authorize(tx, ctx, 'dms.read', { unitId: d.unit_id });
  if (d.confidential) await authorize(tx, ctx, 'dms.confidential', { unitId: d.unit_id });
  return d;
}

export async function addVersion(tx: Tx, ctx: Ctx, id: string, f: { fileName: string; contentType?: string; contentBase64: string; note?: string }) {
  const d = await one(tx, 'SELECT * FROM dms.documents WHERE id = $1 FOR UPDATE', [id]);
  if (!d) throw new NotFoundError('document');
  await authorize(tx, ctx, 'dms.manage', { unitId: d.unit_id });
  if (d.status !== 'active') throw new ValidationError('the document is archived');
  await writeVersion(tx, ctx, id, d.current_version + 1, f);
  return detail(tx, id);
}

/** Archived documents stay readable and keep all versions; nothing is ever deleted. */
export async function archiveDocument(tx: Tx, ctx: Ctx, id: string) {
  const d = await one(tx, 'SELECT * FROM dms.documents WHERE id = $1 FOR UPDATE', [id]);
  if (!d) throw new NotFoundError('document');
  await authorize(tx, ctx, 'dms.manage', { unitId: d.unit_id });
  return one(tx, `UPDATE dms.documents SET status = 'archived' WHERE id = $1 RETURNING *`, [id]);
}

/** The document and its version list (no content), for callers already authorized: whoever filed a document may see what they filed. */
async function detail(tx: Tx, id: string) {
  const d = await one(tx, 'SELECT * FROM dms.documents WHERE id = $1', [id]);
  d.versions = await many(tx, `SELECT version, file_name, content_type, size_bytes, sha256, note, uploaded_by, uploaded_at
                                 FROM dms.versions WHERE document_id = $1 ORDER BY version DESC`, [id]);
  return d;
}

export async function getDocument(tx: Tx, ctx: Ctx, id: string) {
  const d = await readable(tx, ctx, id);
  d.versions = await many(tx, `SELECT version, file_name, content_type, size_bytes, sha256, note, uploaded_by, uploaded_at
                                 FROM dms.versions WHERE document_id = $1 ORDER BY version DESC`, [id]);
  return d;
}

export async function download(tx: Tx, ctx: Ctx, id: string, version?: number) {
  const d = await readable(tx, ctx, id);
  const v = await one(tx, 'SELECT file_name, content_type, content, sha256 FROM dms.versions WHERE document_id = $1 AND version = $2',
    [id, version ?? d.current_version]);
  if (!v) throw new NotFoundError('version');
  return v as { file_name: string; content_type: string; content: Buffer; sha256: string };
}

/** Documents the user may read, optionally those attached to one record. Confidential ones need dms.confidential too. */
export async function listDocuments(tx: Tx, ctx: Ctx, f: { entityType?: string; entityId?: string; category?: string } = {}) {
  const s = await unitScope(tx, ctx.userId!, 'dms.read', 'd.unit_id', 1);
  const c = await unitScope(tx, ctx.userId!, 'dms.confidential', 'd.unit_id', 2);
  return many(tx, `SELECT d.*, v.file_name, v.size_bytes, v.uploaded_at FROM dms.documents d
                     JOIN dms.versions v ON v.document_id = d.id AND v.version = d.current_version
                    WHERE ${s.sql} AND (NOT d.confidential OR ${c.sql})
                      AND ($3::text IS NULL OR d.entity_type = $3) AND ($4::uuid IS NULL OR d.entity_id = $4) AND ($5::text IS NULL OR d.category = $5)
                    ORDER BY d.created_at DESC LIMIT 500`,
    [s.param, c.param, f.entityType ?? null, f.entityId ?? null, f.category ?? null]);
}
