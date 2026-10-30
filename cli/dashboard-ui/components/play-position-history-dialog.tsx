import { useEffect, useMemo, useState } from "react";
import { formatCalendarDate, toActionableErrorMessage } from "../app-helpers";
import { fetchPlayPositionHistory, type PlayHistoryPoint } from "../store-api";

/** Play shows at most 30 results, so the axis stops there (iOS goes to 200). */
const RANK_MIN = 1;
const RANK_MAX = 30;
const RANK_TICKS = [1, 5, 10, 15, 20, 25, 30];
const WIDTH = 760;
const HEIGHT = 250;
const PAD = { top: 14, right: 44, bottom: 34, left: 18 };

type Props = {
  keyword: string;
  country: string;
  appId: string;
  displayLocale?: string;
  onClose: () => void;
};

/** A `YYYY-MM-DD` UTC day; noon keeps it on the same date in any time zone. */
function formatDay(date: string, locale?: string): string {
  return formatCalendarDate(`${date}T12:00:00Z`, locale) || date;
}

type ChartPoint = { x: number; y: number; date: string; position: number };

export function buildPlayHistoryChart(points: PlayHistoryPoint[]) {
  const ranked = points.filter((point) => point.position != null);
  if (ranked.length === 0) return null;
  const innerWidth = WIDTH - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const minTime = toTime(points[0].date);
  const xRange = Math.max(1, toTime(points[points.length - 1].date) - minTime);
  const yRange = RANK_MAX - RANK_MIN;
  const xOf = (date: string) => PAD.left + ((toTime(date) - minTime) / xRange) * innerWidth;
  const yOf = (rank: number) =>
    PAD.top + ((Math.min(RANK_MAX, Math.max(RANK_MIN, rank)) - RANK_MIN) / yRange) * innerHeight;

  // A day outside the top 30 breaks the line rather than being drawn at 30.
  const chartPoints: ChartPoint[] = [];
  let path = "";
  let penDown = false;
  for (const point of points) {
    if (point.position == null) {
      penDown = false;
      continue;
    }
    const chartPoint = {
      x: xOf(point.date),
      y: yOf(point.position),
      date: point.date,
      position: point.position,
    };
    chartPoints.push(chartPoint);
    path += `${penDown ? "L" : "M"} ${chartPoint.x} ${chartPoint.y} `;
    penDown = true;
  }
  const positions = chartPoints.map((point) => point.position);
  return {
    points: chartPoints,
    linePath: path.trim(),
    yTicks: RANK_TICKS.map((rank) => ({ rank, y: yOf(rank) })),
    bestPosition: Math.min(...positions),
    worstPosition: Math.max(...positions),
    daysOutside: points.length - ranked.length,
  };
}

export function PlayPositionHistoryDialog(props: Props) {
  const { keyword, country, appId, onClose } = props;
  const [points, setPoints] = useState<PlayHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchPlayPositionHistory({ appId, keyword, country })
      .then((result) => {
        if (!cancelled) setPoints(result);
      })
      .catch((err) => {
        if (!cancelled) setError(toActionableErrorMessage(err, "Failed to load position history"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, country, keyword]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const chart = useMemo(() => buildPlayHistoryChart(points), [points]);

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <section
        className="dialog-card ui-card position-history-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Google Play position history for ${keyword}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <h2>Google Play position history for "{keyword}"</h2>
          <button type="button" className="dialog-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="dialog-content">
          {loading ? <p className="dialog-message">Loading history...</p> : null}
          {!loading && error ? <p className="dialog-message error">{error}</p> : null}
          {!loading && !error && chart == null ? (
            <p className="dialog-message">
              {points.length > 0
                ? "Not in the top 30 on any day in the last 90 days."
                : "No position history yet."}
            </p>
          ) : null}
          {!loading && !error && chart != null ? (
            <div className="position-history-chart-wrap">
              <div className="position-history-meta">
                <span>
                  Best rank: <strong>{chart.bestPosition}</strong>
                </span>
                <span>
                  Worst rank: <strong>{chart.worstPosition}</strong>
                </span>
                {chart.daysOutside > 0 ? (
                  <span>
                    Days outside the top 30: <strong>{chart.daysOutside}</strong>
                  </span>
                ) : null}
              </div>
              <svg
                className="position-history-chart"
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                role="img"
                aria-label={`Google Play position trend for ${keyword}`}
              >
                {chart.yTicks.map((tick) => (
                  <g key={`y-${tick.rank}`}>
                    <line
                      x1={PAD.left}
                      y1={tick.y}
                      x2={WIDTH - PAD.right}
                      y2={tick.y}
                      className="position-history-guide-line"
                    />
                    <text
                      x={WIDTH - PAD.right + 6}
                      y={tick.y}
                      className="position-history-tick-label"
                      textAnchor="start"
                      dominantBaseline="middle"
                    >
                      {tick.rank}
                    </text>
                  </g>
                ))}
                <line
                  x1={PAD.left}
                  y1={HEIGHT - PAD.bottom}
                  x2={WIDTH - PAD.right}
                  y2={HEIGHT - PAD.bottom}
                  className="position-history-axis"
                />
                <text
                  x={PAD.left}
                  y={HEIGHT - PAD.bottom + 18}
                  className="position-history-tick-label"
                  textAnchor="start"
                >
                  {formatDay(points[0].date, props.displayLocale)}
                </text>
                <text
                  x={WIDTH - PAD.right}
                  y={HEIGHT - PAD.bottom + 18}
                  className="position-history-tick-label"
                  textAnchor="end"
                >
                  {formatDay(points[points.length - 1].date, props.displayLocale)}
                </text>
                <path d={chart.linePath} className="position-history-line" />
                {chart.points.map((point) => (
                  <circle
                    key={point.date}
                    cx={point.x}
                    cy={point.y}
                    r={4}
                    className="position-history-point"
                    tabIndex={0}
                  >
                    <title>
                      {`${formatDay(point.date, props.displayLocale)} • Rank ${point.position}`}
                    </title>
                  </circle>
                ))}
              </svg>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
