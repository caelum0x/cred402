/**
 * Dependency-free SVG sparkline. Renders a series of numbers as a smooth area
 * line, auto-scaled, with an optional accent color and last-value label.
 */
export function Sparkline({
  values,
  width = 240,
  height = 48,
  color = "#7c8aff",
  label,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  label?: string;
}) {
  if (values.length === 0) return <div className="muted">no data</div>;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pad = 3;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const pts = values.map((v, i) => {
    const x = pad + (values.length === 1 ? 0 : (i / (values.length - 1)) * w);
    const y = pad + h - ((v - min) / span) * h;
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const area = `${line} L${last[0].toFixed(1)},${(height - pad).toFixed(1)} L${first[0].toFixed(1)},${(height - pad).toFixed(1)} Z`;
  const id = `g${Math.round(min)}_${Math.round(max)}_${values.length}`;

  return (
    <div className="sparkline">
      {label && <div className="spark-label">{label} <strong>{values[values.length - 1]!.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div>}
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="1.8" />
        <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />
      </svg>
    </div>
  );
}
