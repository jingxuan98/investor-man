interface KnobFieldProps {
  label: React.ReactNode;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  error?: string;
}

// Extracted from ValueTable.tsx (mechanical refactor, no behavior change) so
// LongHorizonDcf.tsx can reuse the same editable-knob input pattern.
export default function KnobField({ label, value, placeholder, onChange, error }: KnobFieldProps) {
  return (
    <div>
      <label className="knob-label">{label}</label>
      <input
        type="number"
        step="0.1"
        inputMode="decimal"
        className="knob-input num"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <p className="mt-1 text-xs text-red">{error}</p>}
    </div>
  );
}
