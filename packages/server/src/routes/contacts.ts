import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CONTACT_LIMIT_CEILING, IMPORT_MAX_BYTES, type ContactsResponse, type ImportPreview, type SegmentsResponse } from '@cl/shared';
import {
  addCustomField, allFields, analyse, commitImport, createContact, deleteContact, getContactLimit, listContacts, markExcluded, removeCustomField, segments, setContactLimit, updateContact,
} from '../contacts.js';
import { withTransaction, type Db } from '../db.js';
import { logActivity } from '../services.js';

const importBody = z.object({
  csv: z.string().max(IMPORT_MAX_BYTES, `The file is larger than ${IMPORT_MAX_BYTES / 1024} KB.`),
  mapping: z.record(z.string().max(100), z.string().max(200)).optional(),
  newFields: z.array(z.object({ column: z.string().max(200), label: z.string().max(100), type: z.enum(['text', 'number', 'date', 'boolean']) })).max(20).optional(),
  updateExisting: z.boolean().optional(),
  filename: z.string().max(200).optional(),
});
const idParam = z.object({ id: z.string().uuid() });
// every typed-in field arrives as text and is checked with the same rules as the import
const contactBody = z.record(z.string().max(60), z.string().max(300));
const BODY_LIMIT = IMPORT_MAX_BYTES * 2 + 4096; // the file plus its JSON wrapping

export function contactRoutes(app: FastifyInstance, db: Db): void {
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: 'not_found', message: 'Contact not found.' });

  app.get('/api/contacts', { config: { access: 'audience.manage' } }, async (): Promise<ContactsResponse> => ({
    contacts: await listContacts(db), max: await getContactLimit(db), ceiling: CONTACT_LIMIT_CEILING, fields: await allFields(db),
  }));

  // The limit on stored contacts: 10 while testing, raised by an Admin when the real audience arrives.
  app.put('/api/audience/settings', { config: { access: 'audience.settings' } }, async (req, reply) => {
    const { contactLimit } = z.object({ contactLimit: z.number() }).parse(req.body);
    const userId = req.auth!.user.id;
    const r = await withTransaction(db, async (q) => {
      const before = await getContactLimit(q);
      const out = await setContactLimit(q, contactLimit, userId);
      if ('limit' in out) await logActivity(q, { actorId: userId, action: 'audience.limit_changed', details: { from: before, to: out.limit } });
      return out;
    });
    return 'error' in r ? reply.status(400).send({ error: 'invalid_limit', message: r.error }) : { contactLimit: r.limit };
  });

  // Custom fields (for example "Country of residence"): anyone who manages the audience may add one.
  app.post('/api/contact-fields', { config: { access: 'audience.manage' } }, async (req, reply) => {
    const { label, type } = z.object({ label: z.string().max(200), type: z.string().max(20) }).parse(req.body);
    const userId = req.auth!.user.id;
    const r = await withTransaction(db, async (q) => {
      const out = await addCustomField(q, label, type, userId);
      if ('field' in out) await logActivity(q, { actorId: userId, action: 'contact_field.created', entityType: 'contact_field', details: { key: out.field.key, label: out.field.label, type: out.field.type } });
      return out;
    });
    return 'error' in r ? reply.status(r.status).send({ error: 'invalid_field', message: r.error }) : reply.status(201).send(r.field);
  });

  app.delete<{ Params: { key: string } }>('/api/contact-fields/:key', { config: { access: 'audience.manage' } }, async (req, reply) => {
    const { key } = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) }).parse(req.params);
    const gone = await withTransaction(db, async (q) => {
      const f = await removeCustomField(q, key);
      if (f) await logActivity(q, { actorId: req.auth!.user.id, action: 'contact_field.deleted', entityType: 'contact_field', details: { key: f.key, label: f.label } });
      return f;
    });
    return gone ? reply.status(204).send() : reply.status(404).send({ error: 'not_found', message: 'Field not found.' });
  });

  // Segments: split the contacts by the fields you choose, e.g. ?fields=country,language
  app.get<{ Querystring: { fields?: string } }>('/api/audience/segments', { config: { access: 'audience.manage' } }, async (req, reply): Promise<SegmentsResponse | FastifyReply> => {
    const keys = z.string().max(800).default('').parse(req.query.fields ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = await segments(db, keys);
    return 'error' in r ? reply.status(400).send({ error: 'invalid_segments', message: r.error }) : r;
  });

  // Step 1 of an import: read the file and say exactly what would happen. Nothing is saved.
  app.post('/api/contacts/import/preview', { bodyLimit: BODY_LIMIT, config: { access: 'audience.manage', rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply): Promise<ImportPreview | FastifyReply> => {
    const b = importBody.parse(req.body);
    const a = await analyse(db, b.csv, b.mapping, b.updateExisting === true, b.newFields);
    if ('error' in a) return reply.status(400).send({ error: 'invalid_file', message: a.error });
    return a.preview;
  });

  // Step 2: save. The analysis runs again inside the transaction, so the result matches the database as it is now.
  app.post('/api/contacts/import', { bodyLimit: BODY_LIMIT, config: { access: 'audience.manage', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = importBody.parse(req.body);
    const userId = req.auth!.user.id;
    const out = await withTransaction(db, async (q) => {
      const r = await commitImport(q, b.csv, b.mapping, b.updateExisting === true, userId, b.filename ?? null, b.newFields);
      if ('error' in r) return r;
      await logActivity(q, {
        actorId: userId, action: 'contacts.imported', entityType: 'import_batch', entityId: r.result.batchId,
        details: { added: r.result.added, updated: r.result.updated, skippedDuplicates: r.result.duplicatesInFile, overLimit: r.result.overLimit, invalid: r.result.invalid },
      });
      return r;
    });
    if ('error' in out) return reply.status(400).send({ error: 'invalid_file', message: out.error });
    return reply.status(201).send(out.result);
  });

  app.post('/api/contacts', { config: { access: 'audience.manage' } }, async (req, reply) => {
    const body = contactBody.parse(req.body);
    const userId = req.auth!.user.id;
    const r = await withTransaction(db, async (q) => {
      const created = await createContact(q, body, userId);
      if ('contact' in created) await logActivity(q, { actorId: userId, action: 'contact.created', entityType: 'contact', entityId: created.contact.id });
      return created;
    });
    return 'error' in r ? reply.status(r.status).send({ error: 'invalid_contact', message: r.error }) : reply.status(201).send(r.contact);
  });

  app.patch<{ Params: { id: string } }>('/api/contacts/:id', { config: { access: 'audience.manage' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = contactBody.parse(req.body);
    const r = await withTransaction(db, async (q) => {
      const updated = await updateContact(q, id, body);
      if ('contact' in updated) await logActivity(q, { actorId: req.auth!.user.id, action: 'contact.updated', entityType: 'contact', entityId: id, details: { fields: Object.keys(body) } });
      return updated;
    });
    return 'error' in r ? reply.status(r.status).send({ error: 'invalid_contact', message: r.error }) : r.contact;
  });

  app.delete<{ Params: { id: string } }>('/api/contacts/:id', { config: { access: 'audience.manage' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const ok = await withTransaction(db, async (q) => {
      const done = await deleteContact(q, id);
      if (done) await logActivity(q, { actorId: req.auth!.user.id, action: 'contact.deleted', entityType: 'contact', entityId: id });
      return done;
    });
    return ok ? reply.status(204).send() : notFound(reply);
  });

  // Record that someone opted out or must not be mailed (one-way). Real unsubscribes and bounces are recorded automatically once sending exists.
  app.post<{ Params: { id: string; kind: string } }>('/api/contacts/:id/mark/:kind', { config: { access: 'audience.manage' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const kind = z.enum(['unsubscribed', 'suppressed']).parse(req.params.kind);
    const c = await withTransaction(db, async (q) => {
      const done = await markExcluded(q, id, kind);
      if (done) await logActivity(q, { actorId: req.auth!.user.id, action: `contact.marked_${kind}`, entityType: 'contact', entityId: id });
      return done;
    });
    return c ?? notFound(reply);
  });
}
