import { avatarColor, initials } from '../lib/format';

export default function Avatar({ name }: { name: string }) {
  const [bg, fg] = avatarColor(name || '?');
  return (
    <div className="avatar" style={{ background: bg, color: fg }}>
      {initials(name || '?')}
    </div>
  );
}
