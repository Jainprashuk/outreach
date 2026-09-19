// Read-only reply-category tag (set by the reply classifier during the mailbox
// scan, not user-editable) — hover shows the one-line reasoning, which names the rule
// when a deterministic rule decided it rather than a model.
import { CATEGORY_BADGE_CLASS, CATEGORY_LABELS } from '../lib/format';

export default function CategoryBadge({ category, reasoning }: {
  category?: string | null;
  reasoning?: string | null;
}) {
  if (!category) return null;
  return (
    <span
      className={`badge ${CATEGORY_BADGE_CLASS[category] || 'badge-queued'}`}
      title={reasoning || undefined}
    >
      {CATEGORY_LABELS[category] || category}
    </span>
  );
}
