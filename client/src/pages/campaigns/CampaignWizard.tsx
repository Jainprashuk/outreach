import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/Layout';
import CampaignStepper from '../../components/campaigns/CampaignStepper';
import ColumnMapper from '../../components/campaigns/ColumnMapper';
import { useApp } from '../../context/AppContext';
import { useToast } from '../../context/ToastContext';
import { readSpreadsheet, type RawSheet } from '../../lib/spreadsheet';
import {
  autoDetect, detectHeaderRow, projectRows, splitGrid, validateMapping,
  EMPTY_MAPPING, type Mapping,
} from '../../lib/campaignMapping';
import { uploadCampaign } from '../../lib/campaignUpload';
import {
  appendCampaignRowsApi, createCampaignApi, deleteCampaignApi, loadCampaignMetaApi,
  type Campaign, type CampaignMeta,
} from '../../lib/api';
import { dripDuration, fmtHour } from '../../lib/campaigns';

type Step = 1 | 2 | 3 | 4;

export default function CampaignWizard() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>(1);

  // Draft state lives here, in memory. Unlike /send/step1..3 — four sibling
  // routes passing state through the query string — a parsed 10k-row grid
  // cannot live in a URL, and nothing is persisted until launch.
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<RawSheet[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [autoHeaderRow, setAutoHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<Mapping>(EMPTY_MAPPING);
  const [auto, setAuto] = useState<Mapping>(EMPTY_MAPPING);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');

  const [name, setName] = useState('');
  const [templateKey, setTemplateKey] = useState('');
  const [contactsPerDay, setContactsPerDay] = useState(25);
  const [ratePerHour, setRatePerHour] = useState(5);
  const [runHourIst, setRunHourIst] = useState(9);
  const [attachResume, setAttachResume] = useState(false);

  const [meta, setMeta] = useState<CampaignMeta | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  // StrictMode double-invokes effects in dev; this latch (plus launching only
  // from onClick, never an effect) is what stops two campaigns being created.
  const launchingRef = useRef(false);

  useEffect(() => { loadCampaignMetaApi().then(setMeta).catch(() => {}); }, []);
  useEffect(() => {
    if (!templateKey) {
      const first = Object.keys(app.templates)[0];
      if (first) setTemplateKey(first);
    }
  }, [app.templates, templateKey]);

  // Closing the tab mid-upload would leave an orphan draft behind.
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  const grid = sheets[sheetIdx]?.grid || [];
  const { headers, rows } = useMemo(() => splitGrid(grid, headerRow), [grid, headerRow]);

  // Free and client-side: the contact list is already loaded, so we can tell the
  // user how many of their rows are people they have already emailed. The server
  // applies the same rule authoritatively at release time.
  const existingEmails = useMemo(
    () => new Set(app.contacts.map((c) => c.email.toLowerCase())),
    [app.contacts],
  );

  // ~15ms at 10k x 50. Deliberately NOT debounced — instant feedback when you
  // change a <select> is the entire point of the mapping screen.
  const report = useMemo(
    () => validateMapping(headers, rows, mapping, headerRow, existingEmails),
    [headers, rows, mapping, headerRow, existingEmails],
  );

  async function handleFile(f: File) {
    setParsing(true);
    setParseError('');
    try {
      const parsed = await readSpreadsheet(f);
      const g = parsed[0].grid;
      const hr = detectHeaderRow(g);
      const split = splitGrid(g, hr);
      const guess = autoDetect(split.headers, split.rows);
      setFile(f);
      setSheets(parsed);
      setSheetIdx(0);
      setHeaderRow(hr);
      setAutoHeaderRow(hr);
      setMapping(guess);
      setAuto(guess);
      if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
      setStep(2);
    } catch (err) {
      setParseError((err as Error).message || 'Could not read that file.');
    } finally {
      setParsing(false);
    }
  }

  function pickSheet(i: number) {
    setSheetIdx(i);
    const g = sheets[i].grid;
    const hr = detectHeaderRow(g);
    const split = splitGrid(g, hr);
    const guess = autoDetect(split.headers, split.rows);
    setHeaderRow(hr);
    setAutoHeaderRow(hr);
    setMapping(guess);
    setAuto(guess);
  }

  function changeHeaderRow(hr: number) {
    setHeaderRow(hr);
    const split = splitGrid(grid, hr);
    const guess = autoDetect(split.headers, split.rows);
    setMapping(guess);
    setAuto(guess);
  }

  async function launch() {
    if (launchingRef.current) return;
    launchingRef.current = true;
    setUploading(true);

    const projected = projectRows(headers, rows, mapping, headerRow);
    // Hopeless rows are dropped here rather than shipped and skipped server-side;
    // the ones that could plausibly become contacts are all uploaded, so the
    // Skipped tab can explain what happened to them.
    const usable = projected.filter((p) => p.email);
    setProgress({ done: 0, total: usable.length });

    try {
      const campaign = await uploadCampaign<Campaign>(usable, {
        create: () => createCampaignApi({
          name: name.trim(), templateKey, contactsPerDay, ratePerHour, runHourIst,
          attachResume,
          columnMap: {
            name: mapping.name, email: mapping.email,
            company: mapping.company, role: mapping.role,
          },
          sourceColumns: headers,
          headerRow,
          fileName: file?.name || '',
        }),
        idOf: (c) => c.id,
        append: (id, payload) => appendCampaignRowsApi(id, payload),
        remove: (id) => deleteCampaignApi(id, true),
        onProgress: (done, total) => setProgress({ done, total }),
      });
      toast(`Campaign started — ${usable.length.toLocaleString()} contacts queued.`, 'success');
      navigate(`/campaigns/${campaign.id}`);
    } catch (err) {
      const msg = (err as Error).message || 'Could not create the campaign';
      toast(msg === 'credentials_missing'
        ? 'Set GMAIL_EMAIL and GMAIL_APP_PASSWORD on the server — campaigns send unattended.'
        : msg, 'error');
      launchingRef.current = false;
      setUploading(false);
    }
  }

  const canContinue = step === 1 ? sheets.length > 0
    : step === 2 ? report.blocking.length === 0
    : step === 3 ? !!name.trim() && !!templateKey
    : true;

  const dripHours = ratePerHour > 0 ? contactsPerDay / ratePerHour : Infinity;
  const dripTooSlow = dripHours > 20;

  return (
    <Layout wide title="New campaign" subtitle="Drip a spreadsheet into outreach, a few contacts a day">
      <CampaignStepper current={step} />

      <div className="form-body" style={{ flex: 1, overflowY: 'auto' }}>
        {step === 1 && (
          <>
            <div className="upload-zone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>
              <i className="ti ti-table-import" />
              <div className="uz-title">
                {parsing ? 'Reading the file…' : file ? file.name : 'Drop an Excel or CSV file here'}
              </div>
              <div className="uz-sub">
                .xlsx, .csv or .tsv — any columns you like, you'll map them next
              </div>
              <button className="btn btn-sm" style={{ marginTop: 12 }} type="button"
                disabled={parsing} onClick={() => fileRef.current?.click()}>
                <i className="ti ti-upload" /> Browse file
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv" style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
            </div>
            {parseError && (
              <div className="info-box" style={{ marginTop: 14, background: 'var(--red-bg)', color: 'var(--red)' }}>
                <i className="ti ti-alert-triangle" /><span>{parseError}</span>
              </div>
            )}
            {meta && meta.credentialSource === 'none' && (
              <div className="info-box" style={{ marginTop: 14, background: 'var(--amber-bg)', color: 'var(--amber)' }}>
                <i className="ti ti-key-off" />
                <span>
                  Campaigns send unattended, so <strong>GMAIL_EMAIL</strong> and <strong>GMAIL_APP_PASSWORD</strong>{' '}
                  must be set on the server. Add them before creating a campaign.
                </span>
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div className="form-grid">
              {sheets.length > 1 && (
                <div className="form-group">
                  <label className="form-label">Sheet</label>
                  <select value={sheetIdx} onChange={(e) => pickSheet(Number(e.target.value))}>
                    {sheets.map((s, i) => (
                      <option key={s.name} value={i}>{s.name} ({s.grid.length} rows)</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Header row</label>
                <select value={headerRow} onChange={(e) => changeHeaderRow(Number(e.target.value))}>
                  <option value={-1}>No header row — use Column A, B, C…</option>
                  {grid.slice(0, 10).map((r, i) => (
                    <option key={i} value={i}>
                      Row {i + 1} — {r.filter(Boolean).slice(0, 4).join(' · ').slice(0, 64)}
                    </option>
                  ))}
                </select>
                {headerRow === autoHeaderRow && (
                  <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 4 }}>
                    <i className="ti ti-wand" /> detected automatically
                  </div>
                )}
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <ColumnMapper headers={headers} rows={rows} mapping={mapping}
                auto={auto} report={report} onChange={setMapping} />
            </div>

            <div className="info-box" style={{
              marginTop: 14,
              ...(report.blocking.length ? { background: 'var(--red-bg)', color: 'var(--red)' } : {}),
            }}>
              <i className={report.blocking.length ? 'ti ti-alert-triangle' : 'ti ti-info-circle'} />
              <span>
                {report.blocking.length > 0
                  ? report.blocking.join(' ')
                  : <>
                      <strong>{report.stats.usable.toLocaleString()}</strong> of{' '}
                      {report.stats.total.toLocaleString()} rows are ready to send.
                      {report.warnings.map((w, i) => <span key={i}> · {w}</span>)}
                    </>}
              </span>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Campaign name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q3 founders list" />
              </div>
              <div className="form-group">
                <label className="form-label">Template</label>
                <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
                  {Object.values(app.templates).map((t) => (
                    <option key={t.key} value={t.key}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Contacts per day</label>
                <input type="number" min={1} max={500} value={contactsPerDay}
                  onChange={(e) => setContactsPerDay(Number(e.target.value))} />
              </div>
              <div className="form-group">
                <label className="form-label">Emails per hour</label>
                <input type="number" min={1} max={60} value={ratePerHour}
                  onChange={(e) => setRatePerHour(Number(e.target.value))} />
              </div>
              <div className="form-group">
                <label className="form-label">Send each day at (IST)</label>
                <select value={runHourIst} onChange={(e) => setRunHourIst(Number(e.target.value))}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{fmtHour(h)}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Attach resume</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" checked={attachResume}
                    onChange={(e) => setAttachResume(e.target.checked)} />
                  Attach the resume from Settings to every email
                </label>
              </div>
            </div>

            <div className="info-box" style={{
              marginTop: 14,
              ...(dripTooSlow ? { background: 'var(--red-bg)', color: 'var(--red)' } : {}),
            }}>
              <i className={dripTooSlow ? 'ti ti-alert-triangle' : 'ti ti-clock'} />
              <span>
                {dripTooSlow
                  ? <>
                      {contactsPerDay} contacts at {ratePerHour}/hour takes {Math.round(dripHours)} hours, so
                      tomorrow's batch would start before today's finished. Use at least{' '}
                      <strong>{Math.ceil(contactsPerDay / 20)}</strong> emails per hour, or lower the daily count.
                    </>
                  : <>
                      {contactsPerDay} per day at {ratePerHour}/hour — each batch takes about{' '}
                      <strong>{dripDuration(contactsPerDay, ratePerHour)}</strong>, starting {fmtHour(runHourIst)} IST.
                      {report.stats.usable > 0 && <> The whole list finishes in about{' '}
                        <strong>{Math.ceil(report.stats.usable / contactsPerDay)} days</strong>.</>}
                    </>}
              </span>
            </div>

            {meta && meta.dailyCommitment + contactsPerDay > meta.dailyCap && (
              <div className="info-box" style={{ marginTop: 10, background: 'var(--amber-bg)', color: 'var(--amber)' }}>
                <i className="ti ti-mail-exclamation" />
                <span>
                  Your running campaigns already commit {meta.dailyCommitment}/day. With this one that is{' '}
                  <strong>{meta.dailyCommitment + contactsPerDay}/day</strong>, over the {meta.dailyCap} you've set as
                  safe for Gmail. Nothing is blocked — just keep an eye on it.
                </span>
              </div>
            )}
          </>
        )}

        {step === 4 && (
          <>
            <div className="info-box">
              <i className="ti ti-rocket" />
              <span>
                <strong>{report.stats.usable.toLocaleString()}</strong> contacts from{' '}
                <strong>{file?.name}</strong> will be emailed using “{app.templates[templateKey]?.name}”,{' '}
                {contactsPerDay} a day from {fmtHour(runHourIst)} IST, one every{' '}
                {Math.round(60 / ratePerHour)} minutes. That's about{' '}
                {Math.ceil(report.stats.usable / contactsPerDay)} days.
              </span>
            </div>

            <div className="table-card" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Company</th><th>Role</th></tr>
                </thead>
                <tbody>
                  {projectRows(headers, rows, mapping, headerRow)
                    .filter((p) => p.email)
                    .slice(0, 25)
                    .map((p, i) => (
                      <tr key={i}>
                        <td>{p.name}</td><td>{p.email}</td><td>{p.company || '—'}</td><td>{p.role || '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            {uploading && (
              <div style={{ marginTop: 14 }}>
                <div className="progress-bar">
                  <div className="progress-fill" style={{
                    width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                  }} />
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>
                  Uploading {progress.done.toLocaleString()} of {progress.total.toLocaleString()} contacts…
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="step-footer">
        <button className="btn" type="button" disabled={uploading}
          onClick={() => (step === 1 ? navigate('/campaigns') : setStep((step - 1) as Step))}>
          <i className="ti ti-arrow-left" /> {step === 1 ? 'Cancel' : 'Back'}
        </button>
        {step < 4 ? (
          <button className="btn btn-primary" type="button" disabled={!canContinue || (step === 3 && dripTooSlow)}
            onClick={() => setStep((step + 1) as Step)}>
            Continue <i className="ti ti-arrow-right" />
          </button>
        ) : (
          // Launch fires ONLY from this click — never from an effect, which under
          // StrictMode would create the campaign twice in development.
          <button className="btn btn-primary" type="button" disabled={uploading} onClick={launch}>
            {uploading
              ? <><i className="ti ti-loader-2" style={{ animation: 'spin 1s linear infinite' }} /> Creating…</>
              : <><i className="ti ti-rocket" /> Start campaign</>}
          </button>
        )}
      </div>
    </Layout>
  );
}
