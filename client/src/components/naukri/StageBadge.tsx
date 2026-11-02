import type { NaukriJob } from '../../lib/api';
import { fmtRunTime } from './format';

// What the recruiter did with an application, read by the track run from the
// site's own history. The hover lists every status the site showed, in its words.
const STAGE_TEXT: Record<string, string> = {
  viewed: 'Viewed by recruiter', shortlisted: 'Shortlisted', contacted: 'Recruiter contacted you', 'not-shortlisted': 'Not shortlisted',
};
const STAGE_BADGE: Record<string, string> = {
  viewed: 'badge-queued', shortlisted: 'badge-approved', contacted: 'badge-approved', 'not-shortlisted': 'badge-seen',
};

export default function StageBadge({ job }: { job: Pick<NaukriJob, 'naukriStage' | 'naukriStageAt' | 'naukriTimeline'> }) {
  if (!job.naukriStage || job.naukriStage === 'applied') return null;
  return (
    <span className={`badge ${STAGE_BADGE[job.naukriStage]}`}
      title={(job.naukriTimeline || []).map(t => `${t.value}${t.at ? ` · ${fmtRunTime(t.at)}` : ''}`).join('\n')}>
      {STAGE_TEXT[job.naukriStage]}{job.naukriStageAt ? ` · ${fmtRunTime(job.naukriStageAt)}` : ''}
    </span>
  );
}
