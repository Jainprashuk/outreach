import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NaukriJob } from '../../lib/api';
import { lookupCompanyApi, startProspectSearchApi } from '../../lib/api';
import { autoPick } from '../../lib/prospects';
import { useToast } from '../../context/ToastContext';

// Find the recruiters and hiring manager at a job's company, in Discover.
// Starts the search straight away when the company's website is certain;
// otherwise Discover opens with the name filled in so you pick which company
// it is. Shared by Applied (follow up on an application) and Skipped (a
// company-site job: reach a person instead of a careers form).
export function useFindPeople() {
  const [finding, setFinding] = useState<string | null>(null);
  const navigate = useNavigate();
  const toast = useToast();

  const findPeople = async (job: Pick<NaukriJob, 'id' | 'company'>) => {
    setFinding(job.id);
    try {
      const r = await lookupCompanyApi(job.company);
      const sure = autoPick(r.candidates);
      if (!sure) {
        navigate(`/discover?find=${encodeURIComponent(job.company)}&job=${job.id}`);
        return;
      }
      const s = await startProspectSearchApi({ domain: sure.domain, companyName: sure.name || job.company, naukriJobId: job.id });
      toast(s.reused ? 'Searched recently — opening those people' : `Finding people at ${sure.name || job.company}…`, 'info');
      navigate(`/discover?domain=${encodeURIComponent(s.search.domain)}`);
    } catch (e: any) {
      toast(e?.message || 'Could not start the search', 'error');
    } finally { setFinding(null); }
  };

  return { findPeople, finding };
}
