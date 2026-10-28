import { useEffect, useState } from 'react';

export interface LoadStep {
  label: string;
  state: 'done' | 'active' | 'pending';
}

/** A short list of what the page is doing right now: finished steps ticked, the running one spinning, a running clock. */
export function LoadSteps({
  steps,
  compact = false,
}: {
  steps: readonly LoadStep[];
  compact?: boolean;
}) {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const done = steps.filter((step) => step.state === 'done').length;
  const seconds = (now - started) / 1000;
  return (
    <div className={`load-progress ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
      <div className="load-bar">
        <i style={{ width: `${Math.max(6, (done / steps.length) * 100)}%` }} />
      </div>
      <ol className="load-steps">
        {steps.map((step) => (
          <li key={step.label} className={step.state === 'pending' ? '' : step.state}>
            <i />
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      {seconds >= 1.5 && <small className="load-clock">{seconds.toFixed(1)} 秒</small>}
    </div>
  );
}
