import { useRef, useState } from 'react';
import type { NaukriConfig } from '../../../lib/api';
import { Card } from '../ui';
import { updateNaukriConfigApi, deleteNaukriResumeApi, naukriConfigApi } from '../../../lib/api';
import { Link } from 'react-router-dom';
import { useToast } from '../../../context/ToastContext';

// The file the worker attaches, and the headlines the daily refresh rotates.
//
// The resume is the one in Settings unless you upload a different file here
// for Naukri only — nobody should have to upload the same file twice. The
// server decides which one is in use (source: 'settings' | 'naukri') and reads
// the AI-draft text from it.
//
// Headline variants exist because Naukri ranks on recency of CHANGE. Writing the
// same string back may not move the stamp, so the refresh rotates through these
// — the server advances the index each time it hands out a run.

export default function ResumeCard({ config, onSaved }: {
  config: NaukriConfig; onSaved: () => void;
}) {
  const [variants, setVariants] = useState<string[]>(config.headlineVariants.length ? config.headlineVariants : ['']);
  const toast = useToast();
  // The config always carries an (empty) resume record, so "is there a file"
  // must mean a file with bytes in it — not merely the record. Treating the
  // empty record as a resume showed "0 KB · Download · Remove" for nothing.
  const [resume, setResume] = useState(config.resume && config.resume.size > 0 ? config.resume : null);
  // The plain text the AI drafts answers from. Pulled from a PDF on upload;
  // editable, because extraction mangles some layouts and Word files give none.
  const [text, setText] = useState(config.resume?.text || '');
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
      setResume({ ...data.resume, source: 'naukri' });
      setText(data.resumeText || '');
      const m = data.extracted
        ? `Uploaded ${data.resume.filename} — text read from it below; check it reads right.`
        : `Uploaded ${data.resume.filename}. No text could be read from it — paste your resume text below for AI drafts.`;
      toast(m, data.extracted ? 'success' : 'info'); setMsg(m);
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not upload', 'error'); setMsg(e?.message || 'Could not upload'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setMsg('');
    try {
      await deleteNaukriResumeApi();
      // Back to the Settings resume, if there is one — ask the server which.
      const r = (await naukriConfigApi()).config.resume;
      setResume(r && r.size > 0 ? r : null); setText(r?.text || '');
      toast(r && r.size > 0 ? 'Removed — using your Settings resume again.' : 'Removed.', 'info');
      onSaved();
    }
    catch (e: any) { toast(e?.message || 'Could not remove', 'error'); setMsg(e?.message || 'Could not remove'); }
    finally { setBusy(false); }
  };

  const saveText = async () => {
    setBusy(true); setMsg('');
    try {
      await updateNaukriConfigApi({ resumeText: text });
      toast('Resume text saved.', 'success'); setMsg('Resume text saved.'); onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  const saveVariants = async () => {
    setBusy(true); setMsg('');
    try {
      await updateNaukriConfigApi({ headlineVariants: variants.filter(v => v.trim()) });
      { toast('Saved.', 'success'); setMsg('Saved.'); }; onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'error'); setMsg(e?.message || 'Could not save'); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Resume & headline" icon="ti-file-cv" collapsible id="resume" defaultOpen={false}>

      <div style={{ marginBottom: 14 }}>
        {resume ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
            <i className="ti ti-file-text" />
            <span>{resume.filename}</span>
            <span style={{ color: 'var(--text2)', fontSize: 12 }}>{Math.max(1, Math.round(resume.size / 1024))} KB</span>
            <a className="btn btn-sm" href="/api/naukri/resume">Download</a>
            {resume.source === 'naukri'
              ? <button className="btn btn-sm" onClick={remove} disabled={busy} title="Go back to the resume in Settings">Remove</button>
              : <Link className="btn btn-sm" to="/settings">Change in Settings</Link>}
          </div>
        ) : (
          <div style={{ color: 'var(--text2)', fontSize: 13 }}>
            No resume yet. Upload it in <Link to="/settings">Settings</Link> — Naukri uses that one — or upload a file here for
            Naukri only.
          </div>
        )}
        {resume && (
          <div style={{ color: 'var(--text2)', fontSize: 11, marginTop: 4 }}>
            {resume.source === 'settings'
              ? 'Using your resume from Settings. Replace it there and Naukri picks up the new one.'
              : 'A Naukri-only file. Remove it to go back to your Settings resume.'}
          </div>
        )}
        <input
          ref={fileRef} type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }}
        />
        <button className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={busy} style={{ marginTop: 8 }}>
          {resume?.source === 'naukri' ? 'Replace Naukri file' : 'Use a different file for Naukri'}
        </button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 4 }}>Resume text (what AI answer drafts are written from)</div>
        <textarea rows={7} style={{ width: '100%', fontSize: 12 }} value={text}
          placeholder="Read automatically from your resume PDF — or paste your resume text here."
          onChange={e => setText(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <button className="btn btn-sm" onClick={saveText} disabled={busy}>Save text</button>
          <span style={{ color: 'var(--text2)', fontSize: 11 }}>
            Only used to draft answers you then check under Jobs → Needs answer. The file above is what gets attached.
          </span>
        </div>
      </div>

      <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 6 }}>Headline variants</div>
      {variants.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <input type="text" style={{ flex: 1 }} value={v}
            onChange={e => setVariants(r => r.map((x, n) => (n === i ? e.target.value : x)))} />
          <button className="btn btn-sm" onClick={() => setVariants(r => r.filter((_, n) => n !== i))}>
            <i className="ti ti-trash" />
          </button>
        </div>
      ))}
      <div style={{ color: 'var(--text2)', fontSize: 11, marginBottom: 8 }}>
        The daily refresh cycles through these. With none set it rewrites your current headline, which
        Naukri may ignore as a no-op — two or three variants make the save reliable.
      </div>

      {msg && <div style={{ color: 'var(--text2)', fontSize: 12, marginBottom: 8 }}>{msg}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-sm" onClick={() => setVariants(r => [...r, ''])}>Add variant</button>
        <button className="btn btn-primary btn-sm" onClick={saveVariants} disabled={busy}>Save headlines</button>
      </div>
    </Card>
  );
}
