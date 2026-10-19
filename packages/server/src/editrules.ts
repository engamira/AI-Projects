import { canonicalJson, hasCapability, type EmailContent, type Role } from '@cl/shared';

// Who may change what inside an email (checked on the server for every save):
//  - Custom HTML blocks: only people with the html.custom capability (Admin) may add, change, remove them.
//  - Everything else (settings, other blocks and their order): only people with campaign.edit (Builder).
// So an Admin who edits custom HTML cannot touch the Builder's content, and a Builder cannot slip in or alter custom HTML.

const custom = (c: EmailContent) => c.blocks.filter((b) => b.type === 'custom_html').map((b) => ({ id: b.id, version: b.sourceVersion, props: b.props }));
const rest = (c: EmailContent) => ({ settings: c.settings, blocks: c.blocks.filter((b) => b.type !== 'custom_html') });

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
