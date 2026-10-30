export function MetricBar({
  value,
  tone,
}: {
  value: number | null;
  tone: "popularity" | "difficulty";
}) {
  if (value == null) return <span className="metric-empty">-</span>;
  const clamped = Math.max(0, Math.min(100, value));
  // For popularity a low score is the weak one, for difficulty a high score is.
  const severity = tone === "difficulty" ? clamped : 100 - clamped;
  const band = severity >= 66 ? "high" : severity >= 33 ? "mid" : "low";
  return (
    <span className="metric">
      <span className="metric-value">{Math.round(value)}</span>
      <span className="metric-track">
        <span
          className={`metric-fill metric-fill--${band}`}
          style={{ width: `${clamped}%` }}
        />
      </span>
    </span>
  );
}
