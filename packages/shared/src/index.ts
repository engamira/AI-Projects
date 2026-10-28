// ---------- Health ----------
export type HealthResponse = {
  status: 'ok' | 'degraded';
  database: 'ok' | 'error' | 'not_configured';
  time: string;
};

// ---------- Roles and capabilities ----------
// Roles are bundles of capabilities. Server code checks capabilities, never role names.
export const ROLES = ['admin', 'builder', 'qa_reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  'users.manage',
  'activity.view',
  'brand.manage',
  'rules.manage',
  'html.custom',
  'assets.manage',
  'campaign.view',
  'campaign.edit',
  'campaign.submit',
  'campaign.delete',
  'audience.manage',
  'audience.settings',
  'campaign.test_send',
  'campaign.send',
  'qa.review',
  'qa.approve',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  admin: ['users.manage', 'activity.view', 'brand.manage', 'rules.manage', 'html.custom', 'assets.manage', 'audience.manage', 'audience.settings', 'campaign.view', 'campaign.delete', 'campaign.test_send', 'campaign.send'],
  builder: ['assets.manage', 'audience.manage', 'campaign.view', 'campaign.edit', 'campaign.submit', 'campaign.delete', 'campaign.test_send', 'campaign.send'],
  qa_reviewer: ['campaign.view', 'qa.review', 'qa.approve'],
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  builder: 'Builder',
  qa_reviewer: 'QA reviewer',
};

export function hasCapability(role: Role, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(cap);
}

// ---------- Auth ----------
export type UserStatus = 'invited' | 'active' | 'disabled';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  capabilities: Capability[];
};

export type SessionStage = 'none' | 'password' | 'full';

export type MeResponse = {
  stage: SessionStage;
  csrfToken?: string;
  user?: SessionUser;
  /** Only for stage "password": what the user must do next. */
  next?: 'enroll_2fa' | 'verify_2fa';
};

export type LoginResponse = { next: 'enroll_2fa' | 'verify_2fa' };

export type EnrollStartResponse = { otpauthUrl: string; qrDataUrl: string; secret: string };
export type EnrollConfirmResponse = { recoveryCodes: string[] };

export type InviteLookupResponse = { email: string; name: string };

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// ---------- Admin: users ----------
export type UserDto = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
};

export type CreateUserRequest = { email: string; name: string; role: Role };
export type InviteResponse = { user: UserDto; inviteUrl: string; expiresAt: string };

// ---------- Notifications and activity ----------
export type NotificationDto = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};
export type NotificationsResponse = { unread: number; items: NotificationDto[] };

export type ActivityDto = {
  id: string;
  actorName: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
};

// ---------- Campaigns and block library ----------
export * from './blocks.js';
export * from './palettes.js';
export * from './brand.js';
export * from './templates.js';
export * from './status.js';
export * from './contacts.js';
export * from './content.js';
export * from './personalize.js';
export * from './presets.js';
export * from './versions.js';
export * from './languages.js';
export * from './rules.js';
export * from './conditions.js';

import type { BlockDefinition } from './blocks.js';
import type { EmailContent } from './content.js';
import type { PlaceholderIssue } from './personalize.js';

export type LibraryResponse = { blocks: BlockDefinition[] };

export type CampaignSummary = {
  id: string;
  name: string;
  status: string;
  createdByName: string | null;
  updatedAt: string;
  revisionCount: number;
  model?: 'legacy' | 'v2';
};

export type DraftDto = { content: EmailContent; version: number; hash: string; updatedAt: string };
export type CampaignDto = { id: string; name: string; status: string; model: 'legacy' | 'v2'; draft: DraftDto };
export type SaveDraftRequest = { content: EmailContent; baseVersion: number };
export type SaveDraftResponse = { version: number; hash: string; updatedAt: string };

export type RevisionDto = {
  id: string;
  number: number;
  kind: 'created' | 'manual' | 'restore' | 'duplicate';
  label: string | null;
  createdByName: string | null;
  createdAt: string;
  hash: string;
  restoredFromNumber: number | null;
};
export type PreviewResponse = { html: string; text: string; warnings: string[]; placeholderIssues: PlaceholderIssue[]; recipientLabel?: string;
  /** Which version of the email is shown, when the campaign has versions for segments. */
  versionLabel?: string;
};
