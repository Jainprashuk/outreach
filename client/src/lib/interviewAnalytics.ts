// Interviews as an ANALYTICS dimension, for both the outreach and the leads views.
//
// An Interview is its own document (see models/Interview.js) — nothing is written
// back to the Contact or Lead it came from, so neither store's own status ever
// says "this person interviewed". That means every funnel here has to join the
// two sides itself, which is what this module does.
//
// Pure functions only. Nothing fetches.
import type { Interview, InterviewSource, InterviewStatus } from './api';
import { INTERVIEW_STATUS_LABELS, INTERVIEW_STATUS_ORDER, isTerminal } from './interviews';

const normEmail = (e?: string | null) => (e || '').trim().toLowerCase();

/**
 * How far along an interview is. Deliberately NOT the display order: a rejection
 * can land at any round, so it ranks lowest rather than highest — when a row has
 * two records, "still scheduled" is the more useful story than "one was rejected".
 */
const PROGRESS: Record<InterviewStatus, number> = {
  rejected: 0,
  'initial-discussion': 1,
  'asked-to-schedule': 2,
  scheduled: 3,
  'in-process': 4,
  selected: 5,
};

/** Reached a real round — booked or beyond, rejections included (they got that far). */
export const reachedRound = (iv: Interview) =>
  iv.status === 'scheduled' || iv.status === 'in-process' || iv.status === 'selected' ||
  // A rejection only counts as a round if the history shows one was actually booked.
  (iv.status === 'rejected' && (iv.statusHistory || []).some(h => h.status === 'scheduled' || h.status === 'in-process'));

// ── Joining interviews back to the row they came from ────────────────────────

export interface InterviewIndex {
  bySource: Map<string, Interview[]>;   // `${sourceType}:${sourceId}`
  byEmail: Map<string, Interview[]>;
}

export function indexInterviews(interviews: Interview[]): InterviewIndex {
  const bySource = new Map<string, Interview[]>();
  const byEmail = new Map<string, Interview[]>();
  const push = (m: Map<string, Interview[]>, k: string, iv: Interview) => {
    const cur = m.get(k);
    if (cur) cur.push(iv); else m.set(k, [iv]);
  };
  interviews.forEach(iv => {
    if (iv.sourceId) push(bySource, `${iv.sourceType}:${iv.sourceId}`, iv);
    const e = normEmail(iv.email);
    if (e) push(byEmail, e, iv);
  });
  return { bySource, byEmail };
}

/**
 * Every interview belonging to one contact or lead row.
 *
 * The email fallback is not redundant: a lead promoted to a contact is usually
 * flagged from the CONTACT side, so `sourceType: 'lead'` never matches even
 * though that lead demonstrably reached an interview. Matching the address too
 * is what lets the leads funnel see its own outcomes.
 */
export function interviewsForRow(
  ix: InterviewIndex, sourceType: InterviewSource, id: string, email?: string | null,
): Interview[] {
  const direct = (id && ix.bySource.get(`${sourceType}:${id}`)) || [];
  const e = normEmail(email);
  const viaEmail = (e && ix.byEmail.get(e)) || [];
  if (!direct.length) return viaEmail;
  if (!viaEmail.length) return direct;
  const seen = new Set(direct.map(iv => iv.id));
  return [...direct, ...viaEmail.filter(iv => !seen.has(iv.id))];
}

/** The furthest-along record for a row — what its badge and funnel step should say. */
export function furthest(list: Interview[]): Interview | null {
  return list.reduce<Interview | null>(
    (best, iv) => (!best || PROGRESS[iv.status] > PROGRESS[best.status] ? iv : best), null);
}

// ── Row-level funnel (contacts or leads) ─────────────────────────────────────

export interface InterviewFunnel {
  /** Rows with at least one interview record. */
  tracked: number;
  /** Rows that got to a booked round or past it. */
  interviewed: number;
  selected: number;
  rejected: number;
  /** Neither selected nor rejected — still worth chasing. */
  live: number;
  /** Live, with the interview date still ahead. */
  upcoming: number;
  /** Interview records reachable from these rows, de-duplicated. */
  records: Interview[];
}

export const EMPTY_FUNNEL: InterviewFunnel = {
  tracked: 0, interviewed: 0, selected: 0, rejected: 0, live: 0, upcoming: 0, records: [],
};

/**
 * Roll every row up into one interview funnel. Counts are per ROW, not per
 * record, so a person tracked twice never inflates the conversion rate; the
 * de-duplicated records come back too for the per-status breakdown.
 */
export function interviewFunnel<T extends { id: string }>(
  rows: T[], ix: InterviewIndex, sourceType: InterviewSource, emailOf: (row: T) => string | null | undefined,
): InterviewFunnel {
  const out = { ...EMPTY_FUNNEL, records: [] as Interview[] };
  const seen = new Set<string>();
  const now = Date.now();

  rows.forEach(row => {
    const list = interviewsForRow(ix, sourceType, row.id, emailOf(row));
    if (!list.length) return;
    list.forEach(iv => { if (!seen.has(iv.id)) { seen.add(iv.id); out.records.push(iv); } });

    out.tracked++;
    if (list.some(reachedRound)) out.interviewed++;
    if (list.some(iv => iv.status === 'selected')) out.selected++;
    // Only a row with nothing still in play counts as rejected.
    else if (list.every(iv => iv.status === 'rejected')) out.rejected++;

    const live = list.filter(iv => !isTerminal(iv));
    if (live.length) {
      out.live++;
      if (live.some(iv => iv.interviewAt && new Date(iv.interviewAt).getTime() >= now)) out.upcoming++;
    }
  });
  return out;
}

/** Records per status, in pipeline order, ready to plot. */
export function statusSpread(records: Interview[]) {
  return INTERVIEW_STATUS_ORDER.map(status => ({
    status,
    label: INTERVIEW_STATUS_LABELS[status],
    n: records.filter(iv => iv.status === status).length,
  }));
}
