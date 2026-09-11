// A four-step clone of pages/send/Stepper.tsx. A clone rather than a shared
// component because that one hard-codes three labels and a `current: 1|2|3`
// type, and widening it would change the existing send wizard.
export default function CampaignStepper({ current }: { current: 1 | 2 | 3 | 4 }) {
  const steps = ['Upload sheet', 'Map columns', 'Configure', 'Review'];
  return (
    <div className="stepper-bar">
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'active' : 'idle';
        return (
          <span key={label} style={{ display: 'contents' }}>
            <div className="step-item">
              <div className={`step-dot ${state}`}>
                {state === 'done' ? <i className="ti ti-check" style={{ fontSize: 12 }} /> : n}
              </div>
              <span className={`step-label ${state === 'active' ? 'active' : 'idle'}`}>{label}</span>
            </div>
            {n < steps.length && <div className="step-line" />}
          </span>
        );
      })}
    </div>
  );
}
