// How sure the app is about a guessed address. Read-only; hover explains why.
import type { EmailConfidence } from '../lib/api';
import { CONFIDENCE_CLASS, CONFIDENCE_HELP, CONFIDENCE_LABEL, PATTERN_EXAMPLE, SOURCE_LABEL } from '../lib/prospects';

export default function ConfidenceBadge({ confidence, pattern, source }: {
  confidence?: EmailConfidence | null;
  pattern?: string | null;
  source?: string | null;
}) {
  if (source === 'manual') {
    return <span className="badge badge-closed" title="You typed this address"><i className="ti ti-pencil" /> Edited</span>;
  }
  if (!confidence) return null;
  const why = [
    CONFIDENCE_HELP[confidence],
    pattern ? `Format: ${pattern}${PATTERN_EXAMPLE[pattern] ? ` (e.g. ${PATTERN_EXAMPLE[pattern]}@)` : ''}` : '',
    source && SOURCE_LABEL[source] ? `From ${SOURCE_LABEL[source]}` : '',
  ].filter(Boolean).join('\n');
  return (
    <span className={`badge ${CONFIDENCE_CLASS[confidence]}`} title={why}>
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}
