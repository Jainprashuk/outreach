import { useRef, useState } from 'react';
import type { NaukriConfig } from '../../../lib/api';
import { updateNaukriConfigApi, deleteNaukriResumeApi } from '../../../lib/api';

// The file the worker attaches, and the headlines the daily refresh rotates.
//
// Its own copy of the resume rather than a pointer at Settings: this feature is
// meant to be deletable in one revert, and sharing a document the rest of the
// app writes would break that. The cost is that you upload it twice; the benefit
// is that nothing else breaks when Naukri goes away.
//
// Headline variants exist because Naukri ranks on recency of CHANGE. Writing the
// same string back may not move the stamp, so the refresh rotates through these
// — the server advances the index each time it hands out a run.

export default function ResumeCard({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const [variants, setVariants] = useState<string[]>(config.headlineVariants.length ? config.headlineVariants : ['']);
  const [resume, setResume] = useState(config.resume || null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true); setMsg('');
    try {
      const fd = new FormData();
      fd.append('resume', file);
      // Not apiFetch's JSON path: multipart must set its own boundary header.
      const res = await fetch('/api/naukri/resume', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setResume(data.resume);
      setMsg(`Uploaded ${data.resume.filename}.`);
      onSaved();
    } catch (e: any) { setMsg(e?.message || 'Could not upload'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setMsg('');
    try { await deleteNaukriResumeApi(); setResume(null); setMsg('Removed.'); onSaved(); }
    catch (e: any) { setMsg(e?.message || 'Could not remove'); }
    finally { setBusy(false); }
  };

  const saveVariants = async () => {
    setBusy(true); setMsg('');
    try {
      await updateNaukriConfigApi({ headlineVariants: variants.filter(v => v.trim()) });
      setMsg('Saved.'); onSaved();
    } catch (e: any) { setMsg(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <i className="ti ti-file-cv" />
        <strong style={{ flex: 1 }}>Resume &amp; headline</strong>
      </div>

      <div style={{ marginBottom: 14 }}>
        {resume ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
            <i className="ti ti-file-text" />
            <span>{resume.filename}</span>
            <span className="page-info">{Math.round(resume.size / 1024)} KB</span>
            <a className="btn btn-sm" href="/api/naukri/resume">Download</a>
            <button className="btn btn-sm" onClick={remove} disabled={busy}>Remove</button>
          </div>
        ) : (
          <div className="page-info" style={{ fontSize: 13 }}>
            No resume uploaded. The apply step needs one where Naukri asks for a fresh file.
          </div>
        )}
        <input
          ref={fileRef} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }}
        />
        <button className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={busy} style={{ marginTop: 8 }}>
          {resume ? 'Replace' : 'Upload'} resume
        </button>
      </div>

      <div className="page-info" style={{ marginBottom: 6 }}>Headline variants</div>
      {variants.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <input className="input" style={{ flex: 1 }} value={v}
            onChange={e => setVariants(r => r.map((x, n) => (n === i ? e.target.value : x)))} />
          <button className="btn btn-sm" onClick={() => setVariants(r => r.filter((_, n) => n !== i))}>
            <i className="ti ti-trash" />
          </button>
        </div>
      ))}
      <div className="page-info" style={{ fontSize: 11, marginBottom: 8 }}>
        The daily refresh cycles through these. With none set it rewrites your current headline, which
        Naukri may ignore as a no-op — two or three variants make the save reliable.
      </div>

      {msg && <div className="page-info" style={{ fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-sm" onClick={() => setVariants(r => [...r, ''])}>Add variant</button>
        <button className="btn btn-primary btn-sm" onClick={saveVariants} disabled={busy}>Save headlines</button>
      </div>
    </div>
  );
}
