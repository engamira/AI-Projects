import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hasCapability, type CampaignAudienceDto, type ContactField, type PreviewRecipientsResponse, type TestContactDto } from '@cl/shared';
import { clearTestContacts, generateTestAudience, getAudienceFields, listTestContacts, previewRecipients, removeTestContact, setAudienceFields } from '../campaignAudience.js';
import { allFields } from '../contacts.js';
import { DEFAULT_WORKSPACE_ID, withTransaction, type Db } from '../db.js';
import { logActivity } from '../services.js';

const idParam = z.object({ id: z.string().uuid() });
const fieldsBody = z.object({ fields: z.array(z.string().max(60)).max(20) });
const testBody = z.object({
  mode: z.enum(['sheet', 'values', 'combos']),
  combos: z.object({ fields: z.array(z.string().max(60)).max(11), rows: z.array(z.array(z.string().max(100)).max(11)).max(2000), codes: z.array(z.string().max(200)).max(2000).optional() }).optional(),
  values: z.record(z.string().max(60), z.array(z.string().max(100)).max(30)).optional(),
});

export function campaignAudienceRoutes(app: FastifyInstance, db: Db): void {
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: 'not_found', message: 'Email not found.' });
  /** The campaign's status, or undefined when it does not exist. Audience set-up can only change while it is a draft. */
  const statusOf = async (id: string): Promise<string | undefined> =>
    (await db.query<{ status: string }>('SELECT status FROM campaign WHERE id = $1 AND workspace_id = $2', [id, DEFAULT_WORKSPACE_ID])).rows[0]?.status;
  const locked = (reply: FastifyReply) => reply.status(409).send({ error: 'locked', message: 'This email can no longer be edited.' });

  // The fields that segment this email, the fields that can be chosen, and the generated test audience.
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/audience', { config: { access: 'campaign.view' } }, async (req, reply): Promise<{ audience: CampaignAudienceDto; available: ContactField[]; test: TestContactDto[] } | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    if (!(await statusOf(id))) return notFound(reply);
    const available = (await allFields(db)).filter((f) => f.key !== 'email' && f.key !== 'marketing_permission');
    return { audience: { fields: await getAudienceFields(db, id) }, available, test: await listTestContacts(db, id) };
  });

  // Choose the segmentation fields (for example Country + Language). Changing them removes the old test audience.
  app.put<{ Params: { id: string } }>('/api/campaigns/:id/audience', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { fields } = fieldsBody.parse(req.body);
    const status = await statusOf(id);
    if (!status) return notFound(reply);
    if (status !== 'draft') return locked(reply);
    const userId = req.auth!.user.id;
    const r = await withTransaction(db, async (q) => {
      const out = await setAudienceFields(q, id, fields, userId);
      if ('fields' in out) await logActivity(q, { actorId: userId, action: 'campaign.audience_fields_set', entityType: 'campaign', entityId: id, details: { fields: out.fields } });
      return out;
    });
    return 'error' in r ? reply.status(400).send({ error: 'invalid_audience', message: r.error }) : { fields: r.fields };
  });

  // Add to the test audience: one made-up contact for each segment, to try the email against. Existing ones are kept.
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/test-audience', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = testBody.parse(req.body);
    const status = await statusOf(id);
    if (!status) return notFound(reply);
    if (status !== 'draft') return locked(reply);
    const userId = req.auth!.user.id;
    const r = await withTransaction(db, async (q) => {
      const out = await generateTestAudience(q, id, body);
      if ('result' in out) await logActivity(q, { actorId: userId, action: 'campaign.test_audience_added', entityType: 'campaign', entityId: id, details: { mode: body.mode, added: out.result.added, total: out.result.contacts.length } });
      return out;
    });
    return 'error' in r ? reply.status(400).send({ error: 'invalid_test_audience', message: r.error }) : reply.status(201).send(r.result);
  });

  app.delete<{ Params: { id: string } }>('/api/campaigns/:id/test-audience', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const status = await statusOf(id);
    if (!status) return notFound(reply);
    if (status !== 'draft') return locked(reply);
    await clearTestContacts(db, id);
    return reply.status(204).send();
  });

  // Remove one test contact.
  app.delete<{ Params: { id: string; contactId: string } }>('/api/campaigns/:id/test-audience/:contactId', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { contactId } = z.object({ contactId: z.string().uuid() }).parse(req.params);
    const status = await statusOf(id);
    if (!status) return notFound(reply);
    if (status !== 'draft') return locked(reply);
    return (await removeTestContact(db, id, contactId)) ? reply.status(204).send() : reply.status(404).send({ error: 'not_found', message: 'Test contact not found.' });
  });

  // Who "Preview as..." can show the email to. Real contacts are listed only for people allowed to see the audience.
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/preview-recipients', { config: { access: 'campaign.view' } }, async (req, reply): Promise<PreviewRecipientsResponse | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    if (!(await statusOf(id))) return notFound(reply);
    return previewRecipients(db, id, hasCapability(req.auth!.user.role, 'audience.manage'));
  });
}
