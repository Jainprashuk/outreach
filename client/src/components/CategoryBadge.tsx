// Read-only reply-category tag (set by the Gemini classifier during the mailbox
// scan, not user-editable) — hover shows the model's one-line reasoning.
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
