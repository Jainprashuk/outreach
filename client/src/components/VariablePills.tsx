import { allVariables } from '../lib/format';
import { useApp } from '../context/AppContext';

export default function VariablePills({ onInsert }: { onInsert?: (key: string) => void }) {
  const { sender } = useApp();
  const vars = allVariables(sender.customVariables);
  return (
    <>
      {vars.map(v => (
        <span
          key={v.key}
          className={`var-pill${v.custom ? ' custom' : ''}${onInsert ? ' clickable' : ''}`}
          onClick={onInsert ? () => onInsert(v.key) : undefined}
          title={v.desc || ''}
        >
          {'{{'}{v.key}{'}}'}
        </span>
      ))}
    </>
  );
}
