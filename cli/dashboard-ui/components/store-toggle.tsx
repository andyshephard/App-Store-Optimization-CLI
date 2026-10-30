import { STORE_MODES, type StoreMode } from "../store-merge";

type StoreToggleProps = {
  value: StoreMode;
  onChange: (mode: StoreMode) => void;
};

/** App Store | Google Play | Both. Shown only when the server has Play. */
export function StoreToggle(props: StoreToggleProps) {
  return (
    <div className="store-toggle" role="group" aria-label="Store">
      {STORE_MODES.map((entry) => (
        <button
          key={entry.mode}
          type="button"
          className={`store-toggle-option ${props.value === entry.mode ? "active" : ""}`}
          aria-pressed={props.value === entry.mode}
          onClick={() => props.onChange(entry.mode)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
