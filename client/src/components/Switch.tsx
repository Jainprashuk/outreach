/** On/off switch on top of a real checkbox (keyboard + screen reader friendly). */
export default function Switch({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string;
}) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  );
}
