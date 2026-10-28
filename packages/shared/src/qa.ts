// QA: findings, severities, and the status of a language email, which is worked out from its findings and approval
// (never from the last button that was clicked).

export const QA_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type QaSeverity = (typeof QA_SEVERITIES)[number];
export const SEVERITY_LABELS: Record<QaSeverity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
/** Findings of these severities must be resolved or ignored before an email can be approved. */
export const BLOCKING_SEVERITIES: readonly QaSeverity[] = ['critical', 'high'];

export const QA_CATEGORIES = ['settings', 'content', 'links', 'images', 'personalization', 'rules', 'localization', 'html', 'accessibility'] as const;
export type QaCategory = (typeof QA_CATEGORIES)[number];

export type IssueStatus = 'open' | 'sent_for_correction' | 'retest' | 'resolved' | 'ignored';
export type SubmissionState = 'started' | 'sent_for_corrections' | 'retest' | 'approved' | 'withdrawn';
export type QaStatus = 'not_submitted' | 'started' | 'sent_for_corrections' | 'retest' | 'approved';

export const QA_STATUS_LABELS: Record<QaStatus, string> = {
  not_submitted: 'Not sent to QA', started: 'Started', sent_for_corrections: 'Sent for Corrections', retest: 'Retest', approved: 'Approved',
};

export const issueLabel = (n: number): string => `QA-${String(n).padStart(4, '0')}`;

export type QaIssueDto = {
  id: string;
  number: number;
  label: string;
  submissionId: string;
  variantId: string;
  revisionId: string;
  revisionNumber: number;
  languageId: string;
  languageName: string;
  checkId: string;
  category: QaCategory;
  severity: QaSeverity;
  source: 'deterministic' | 'ai';
  blockId: string | null;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  status: IssueStatus;
  reviewerComment: string | null;
  ignoredReason: string | null;
  suppressedBy: string | null;
  correctionStatus: 'pending' | 'retest_requested' | 'resolved' | 'withdrawn' | null;
  carriedFrom: string | null;
};

export type QaSubmissionDto = {
  id: string;
  variantId: string;
  revisionId: string;
  revisionNumber: number;
  state: SubmissionState;
  submittedByName: string | null;
  createdAt: string;
  previousSubmissionId: string | null;
  approval: { reviewerName: string | null; approvedAt: string } | null;
  runs: { id: string; kind: 'deterministic' | 'ai'; startedAt: string; finishedAt: string | null; coverage: { ran: string[]; notRun: string[] } }[];
};

export type QaVariantOverview = {
  variantId: string;
  languageId: string;
  languageName: string;
  emailName: string;
  latestRevision: number | null;
  status: QaStatus;
  /** The submission under review (the newest), if any. */
  submission: QaSubmissionDto | null;
  openIssues: number;
  blockingIssues: number;
  newerRevisionExists: boolean;
};

export type CorrectionDto = {
  id: string;
  issue: QaIssueDto;
  campaignId: string;
  campaignName: string;
  variantId: string;
  emailName: string;
  status: 'pending' | 'retest_requested' | 'resolved' | 'withdrawn';
  qaNote: string | null;
  originalDescription: string;
  originalRevisionNumber: number;
  assignedToName: string | null;
  createdAt: string;
};

export type SuppressionRuleDto = {
  id: string;
  scope: 'project' | 'global';
  campaignId: string | null;
  campaignName: string | null;
  checkId: string;
  fingerprint: string | null;
  description: string;
  reason: string;
  createdByName: string | null;
  createdAt: string;
  revokedByName: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
};

/**
 * The status of an email's current submission, from what is true about it:
 *  approved: approved for exactly that revision.
 *  sent_for_corrections: at least one finding was sent back and is not fixed yet.
 *  retest: this submission follows a correction and has no finding waiting for the builder.
 *  started: otherwise (under review).
 */
export function deriveQaStatus(p: { hasSubmission: boolean; approved: boolean; isRetest: boolean; issues: { status: IssueStatus }[] }): QaStatus {
  if (!p.hasSubmission) return 'not_submitted';
  if (p.approved) return 'approved';
  if (p.issues.some((i) => i.status === 'sent_for_correction')) return 'sent_for_corrections';
  if (p.isRetest) return 'retest';
  return 'started';
}

/** Findings that still block approval. */
export const isBlocking = (i: { severity: QaSeverity; status: IssueStatus }): boolean =>
  BLOCKING_SEVERITIES.includes(i.severity) && (i.status === 'open' || i.status === 'sent_for_correction' || i.status === 'retest');
