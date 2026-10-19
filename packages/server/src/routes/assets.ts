import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ASSET_MAX_BYTES } from '@cl/shared';
import { getAssetFile, getVariantFile, listAssets, saveAsset } from '../assets.js';
import type { Db } from '../db.js';
import { logActivity } from '../services.js';

export async function assetRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Upload (multipart form with one file). Registered in its own scope so the upload parser only applies here.
  await app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: ASSET_MAX_BYTES, files: 1, fields: 0 } });
    scope.post('/api/assets', { config: { access: 'assets.manage', rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const file = await req.file();
      if (!file) return reply.status(400).send({ error: 'no_file', message: 'Choose a picture to upload.' });
      const buf = await file.toBuffer();
      if (file.file.truncated) return reply.status(413).send({ error: 'too_large', message: `The picture is larger than ${ASSET_MAX_BYTES / 1048576} MB. Please reduce its size.` });
      const userId = req.auth!.user.id;
      const saved = await saveAsset(db, buf, file.filename, userId);
      if ('error' in saved) return reply.status(400).send({ error: 'invalid_image', message: saved.error });
      if (saved.created) {
        await logActivity(db, { actorId: userId, action: 'asset.uploaded', entityType: 'asset', entityId: saved.asset.id, details: { filename: saved.asset.filename, bytes: saved.asset.sizeBytes } });
      }
      return reply.status(saved.created ? 201 : 200).send(saved.asset);
    });
  });

  app.get('/api/assets', { config: { access: 'assets.manage' } }, async () => listAssets(db));

  const send = (reply: import('fastify').FastifyReply, file: { mime: string; data: Buffer }) =>
    reply
      .header('content-type', file.mime)
      .header('content-length', file.data.length)
      .header('content-disposition', 'inline')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('cross-origin-resource-policy', 'cross-origin') // helmet's default would block other sites (email apps) from showing it
      .header('x-content-type-options', 'nosniff')
      .send(file.data);

  // Cropped copy, e.g. /media/<id>/square-240.jpg (speaker photos) or /media/<id>/card-480.jpg (4:3 cards).
  app.get<{ Params: { id: string; variant: string } }>('/media/:id/:variant', { config: { rateLimit: false } }, async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const file = await getVariantFile(db, id.data, req.params.variant);
    if (!file) return reply.status(404).send({ error: 'not_found' });
    return send(reply, file);
  });

  // Public on purpose: email apps load pictures from this address when a recipient opens the email.
  // The id is random and unguessable; nothing but images can ever be stored here.
  app.get<{ Params: { id: string } }>('/media/:id', { config: { rateLimit: false } }, async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.status(404).send({ error: 'not_found' });
    const file = await getAssetFile(db, id.data);
    if (!file) return reply.status(404).send({ error: 'not_found' });
    return send(reply, file);
  });
}
