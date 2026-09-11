import { Route, Routes } from 'react-router-dom';
import CampaignList from './CampaignList';
import CampaignWizard from './CampaignWizard';
import CampaignDetail from './CampaignDetail';
// The single import site for the campaign styles — a new file importing a new
// file, so main.tsx stays untouched.
import '../../styles/campaigns.css';

/**
 * Hosts the three campaign screens behind one splat route in App.tsx, so adding
 * this feature costs exactly one <Route> line there.
 */
export default function CampaignsRouter() {
  return (
    <Routes>
      <Route path="" element={<CampaignList />} />
      <Route path="new" element={<CampaignWizard />} />
      <Route path=":id" element={<CampaignDetail />} />
    </Routes>
  );
}
