import { FIELDS, colLetter, type Field, type Mapping, type MappingReport } from '../../lib/campaignMapping';

/**
 * One row per OUR field, not per their column.
 *
 * We have four targets; a sheet may have fifty columns. A per-their-column
 * layout would mean fifty rows, forty-six of which say "ignore", and it would
 * make "email is unmapped" invisible. This way required-ness is structural.
 */
export default function ColumnMapper({ headers, rows, mapping, auto, report, onChange }: {
  headers: string[];
  rows: string[][];
  mapping: Mapping;
  auto: Mapping;
  report: MappingReport;
  onChange: (next: Mapping) => void;
}) {
  // A column already claimed by another field, so the same column can't silently
  // feed two fields.
  const takenBy = (col: number): Field | null => {
    if (mapping.email === col) return 'email';
    if (mapping.company === col) return 'company';
    if (mapping.role === col) return 'role';
    if ((mapping.name || []).includes(col)) return 'name';
    return null;
  };

  const setField = (field: Field, value: string, slot = 0) => {
    const idx = value === '' ? null : Number(value);
    if (field === 'name') {
      const cur = [...(mapping.name || [])];
      if (idx === null) cur.splice(slot, 1); else cur[slot] = idx;
      const cleaned = cur.filter((v) => v !== null && v !== undefined);
      onChange({ ...mapping, name: cleaned.length ? cleaned : null });
      return;
    }
    onChange({ ...mapping, [field]: idx } as Mapping);
  };

  // The first three NON-EMPTY values: three blank cells tell you nothing about
  // which column you are looking at, which is the entire point of this cell.
  const samples = (col: number) => {
    const out: string[] = [];
    for (const r of rows) {
      const v = (r[col] || '').trim();
      if (v && out.length < 3) out.push(v);
      if (out.length === 3) break;
    }
    return out;
  };

  const isAuto = (field: Field) => {
    if (field === 'name') {
      return JSON.stringify(mapping.name) === JSON.stringify(auto.name) && mapping.name !== null;
    }
    return mapping[field] !== null && mapping[field] === auto[field];
  };

  const options = (self: Field) => (
    <>
      <option value="">— not mapped —</option>
      {headers.map((h, i) => {
        const owner = takenBy(i);
        return (
          <option key={i} value={i} disabled={owner !== null && owner !== self}>
            {h || `Column ${colLetter(i)}`}{owner && owner !== self ? `  (used for ${owner})` : ''}
          </option>
        );
      })}
    </>
  );

  const quality = (field: Field) => {
    const q = report.perField[field];
    if (!q || !q.mapped) return <span style={{ color: 'var(--text3)', fontSize: 12 }}>—</span>;
    return (
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        <span className="badge badge-sent">{q.filled.toLocaleString()} filled</span>
        {q.blank > 0 && <span className="badge badge-pending">{q.blank.toLocaleString()} blank</span>}
        {q.invalid > 0 && <span className="badge badge-rejected">{q.invalid.toLocaleString()} invalid</span>}
      </div>
    );
  };

  const nameCols = mapping.name || [];

  return (
    <div className="table-card">
      <table>
        <thead>
          <tr>
            <th style={{ width: 170 }}>Our field</th>
            <th style={{ width: 260 }}>Your column</th>
            <th>Sample values</th>
            <th style={{ width: 200 }}>Quality</th>
          </tr>
        </thead>
        <tbody>
          {FIELDS.map((f) => {
            const cols = f.key === 'name' ? nameCols : (mapping[f.key] !== null ? [mapping[f.key] as number] : []);
            return (
              <tr key={f.key} className="cmp-map-row">
                <td>
                  <div style={{ fontWeight: 500 }}>{f.label}</div>
                  <span className={`badge ${f.required ? 'badge-rejected' : 'badge-queued'}`}
                    style={{ marginTop: 4, display: 'inline-block' }}>
                    {f.required ? 'required' : 'optional'}
                  </span>
                </td>
                <td>
                  <select value={f.key === 'name' ? (nameCols[0] ?? '') : (mapping[f.key] ?? '')}
                    onChange={(e) => setField(f.key, e.target.value, 0)}>
                    {options(f.key)}
                  </select>
                  {/* Split-name sheets ("First Name" + "Last Name") are the most
                      common export shape, so joining two columns is offered
                      inline rather than requiring a fix in Excel first. */}
                  {f.key === 'name' && nameCols.length > 0 && (
                    <select value={nameCols[1] ?? ''} style={{ marginTop: 6 }}
                      onChange={(e) => setField('name', e.target.value, 1)}>
                      <option value="">— no second name column —</option>
                      {headers.map((h, i) => {
                        const owner = takenBy(i);
                        return (
                          <option key={i} value={i} disabled={owner !== null && owner !== 'name'}>
                            {h || `Column ${colLetter(i)}`}
                          </option>
                        );
                      })}
                    </select>
                  )}
                  {isAuto(f.key) && (
                    <div style={{ fontSize: 11, color: 'var(--green)', marginTop: 4 }}>
                      <i className="ti ti-wand" /> auto-detected
                    </div>
                  )}
                </td>
                <td className="cmp-sample">
                  {cols.length === 0
                    ? <span style={{ color: 'var(--text3)' }}>—</span>
                    : samples(cols[0]).length === 0
                      ? <em style={{ color: 'var(--text3)', fontSize: 12 }}>(all blank)</em>
                      : samples(cols[0]).map((v, i) => (
                          <span key={i} className="var-pill" style={{ marginRight: 4 }}>{v}</span>
                        ))}
                  {cols.length > 1 && (
                    <div style={{ marginTop: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--text3)', marginRight: 4 }}>+</span>
                      {samples(cols[1]).map((v, i) => (
                        <span key={i} className="var-pill" style={{ marginRight: 4 }}>{v}</span>
                      ))}
                    </div>
                  )}
                </td>
                <td>{quality(f.key)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
