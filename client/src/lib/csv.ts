// Shared CSV parsing — identical column detection to the classic pages.
export interface CsvRow { name: string; email: string; company: string; role: string; }

export function parseCsvText(text: string): CsvRow[] {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));
  const get = (row: string[], ...keys: string[]) => {
    for (const k of keys) {
      const i = headers.indexOf(k);
      if (i !== -1) return (row[i] || '').replace(/"/g, '').trim();
    }
    return '';
  };
  return lines.slice(1).map(line => {
    const row = line.split(',');
    return {
      name: get(row, 'name', 'full name', 'fullname'),
      email: get(row, 'email', 'email address'),
      company: get(row, 'company', 'organisation', 'organization'),
      role: get(row, 'role', 'designation', 'title'),
    };
  });
}

export const readFileText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(String(e.target?.result || ''));
    reader.onerror = reject;
    reader.readAsText(file);
  });

// Serialize rows to a delimited text (CSV with ',' or TSV with '\t').
// RFC-4180 quoting: a field is wrapped in quotes and internal quotes doubled
// whenever it contains the delimiter, a quote, or a newline.
export function toDelimitedText(headers: string[], rows: string[][], delimiter: string): string {
  const esc = (val: string) => {
    const s = val ?? '';
    return /[",\n\r]/.test(s) || s.includes(delimiter)
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const line = (cells: string[]) => cells.map(esc).join(delimiter);
  return [line(headers), ...rows.map(line)].join('\n');
}

// Trigger a browser download of text content as a file.
export function downloadTextFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
