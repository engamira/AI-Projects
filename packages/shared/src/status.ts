// What stage a campaign is at. Only "draft" exists until review and sending are built (M6, M7);
// the later stages are defined now so the list can already show them in plain words.

export type StatusInfo = { label: string; hint: string; tone: 'neutral' | 'info' | 'warn' | 'good'; deletable: boolean };

export const CAMPAIGN_STATUS: Record<string, StatusInfo> = {
  draft: { label: 'Draft', hint: 'Being built by a Builder. Not sent for QA yet.', tone: 'neutral', deletable: true },
  submitted: { label: 'Waiting for QA', hint: 'Submitted and waiting for a QA reviewer to start.', tone: 'info', deletable: false },
  in_review: { label: 'In QA review', hint: 'A QA reviewer is checking it.', tone: 'info', deletable: false },
  changes_requested: { label: 'Changes requested', hint: 'QA asked for changes. The Builder needs to fix and resubmit.', tone: 'warn', deletable: true },
  approved: { label: 'Approved', hint: 'Approved by QA and ready to send.', tone: 'good', deletable: false },
  sending: { label: 'Sending', hint: 'Being sent now.', tone: 'info', deletable: false },
  sent: { label: 'Sent', hint: 'Sent to the audience.', tone: 'good', deletable: false },
};

const UNKNOWN: StatusInfo = { label: 'Unknown', hint: 'Unrecognised status.', tone: 'neutral', deletable: false };
export const campaignStatus = (status: string): StatusInfo => CAMPAIGN_STATUS[status] ?? { ...UNKNOWN, label: status };
