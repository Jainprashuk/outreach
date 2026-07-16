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
