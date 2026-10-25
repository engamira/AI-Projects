import { canonicalJson, hasCapability, type EmailContent, type Role } from '@cl/shared';

// Who may change what inside an email (checked on the server for every save):
//  - Custom HTML blocks: only people with the html.custom capability (Admin) may add, change, remove them.
//  - Everything else (settings, other blocks and their order): only people with campaign.edit (Builder).
// So an Admin who edits custom HTML cannot touch the Builder's content, and a Builder cannot slip in or alter custom HTML.

// The Default version and every segment version count: a custom HTML block in any of them is Admin-only.
const versions = (c: EmailContent) => [{ key: 'default', fields: [] as string[], values: [] as string[], settings: c.settings, blocks: c.blocks }, ...(c.variants ?? []).map((v) => ({ ...v, key: v.id }))];
const custom = (c: EmailContent) => versions(c).flatMap((v) => v.blocks.filter((b) => b.type === 'custom_html').map((b) => ({ v: v.key, id: b.id, version: b.sourceVersion, props: b.props })));
const rest = (c: EmailContent) => versions(c).map((v) => ({ v: v.key, fields: v.fields, values: v.values, settings: v.settings, blocks: v.blocks.filter((b) => b.type !== 'custom_html') }));

/** Returns a message when `role` is not allowed to turn `before` into `after`, otherwise null. */
export function roleEditRefusal(role: Role, before: EmailContent, after: EmailContent): string | null {
  const canEdit = hasCapability(role, 'campaign.edit');
  const canHtml = hasCapability(role, 'html.custom');
  if (!canHtml && canonicalJson(custom(before)) !== canonicalJson(custom(after))) {
    return 'Only an Admin can add, change or remove Custom HTML blocks.';
  }
  if (!canEdit && canonicalJson(rest(before)) !== canonicalJson(rest(after))) {
    return 'You can only change Custom HTML blocks in an email. Other content is edited by a Builder.';
  }
  return null;
}
