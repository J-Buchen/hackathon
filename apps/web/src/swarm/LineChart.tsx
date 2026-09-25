import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

/**
 * Minimal, dependency-free SVG line chart for the center-book section.
 *
 * Follows the dataviz spec used across the site: one y-axis, 2px lines, hairline
 * solid gridlines, end-dots with a surface ring, a legend for ≥ 2 series plus
 * direct end labels, a crosshair that snaps to the nearest tick with ONE tooltip
 * listing every series, keyboard access (←/→ on the focused chart), and a data
 * table fallback so no value is gated behind hover.
 *
 * The viewBox tracks the plot's rendered width (ResizeObserver), so axis and
 * label text keep their size on a phone instead of scaling down with the SVG.
 */

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

export interface Band {
  from: number;
  to: number;
  label: string;
}

export interface Marker {
  at: number;
  label: string;
}

interface Props {
  title: string;
  series: Series[];
  format: (v: number) => string;
  xLabel: (i: number) => string;
  bands?: Band[];
  markers?: Marker[];
  /** Draw a baseline at this y value (e.g. 0 for exposure). */
  baseline?: number;
  height?: number;
  /** Row step for the table view. */
  tableStep?: number;
}

const WIDE = 760;
const PAD_WIDE = { top: 16, right: 92, bottom: 30, left: 64 };
const PAD_NARROW = { top: 16, right: 58, bottom: 30, left: 48 };

function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export function LineChart({
  title,
  series,
  format,
  xLabel,
  bands = [],
  markers = [],
  baseline,
  height = 260,
  tableStep = 10,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(WIDE);
  useEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      // Draw at the true width (never below 300), so 11px text stays 11px.
      if (w > 0) setW(Math.max(300, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const PAD = W < 560 ? PAD_NARROW : PAD_WIDE;
  // Keep a sensible aspect as the width changes: flatter than the design box
  // on phones, a little taller on wide panels.
  const h = Math.round(Math.min(height * 1.3, Math.max(height * 0.85, (W / WIDE) * height)));
  const id = useId();
  const n = Math.max(...series.map((s) => s.values.length));

  const geo = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) for (const v of s.values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (baseline !== undefined) {
      lo = Math.min(lo, baseline);
      hi = Math.max(hi, baseline);
    }
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad;
    hi += pad;
    const ticks = niceTicks(lo, hi);
    const x = (i: number) => PAD.left + (i / Math.max(1, n - 1)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (h - PAD.top - PAD.bottom);
    const paths = series.map((s) =>
      s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(""),
    );
    return { lo, hi, ticks, x, y, paths };
  }, [series, n, h, baseline, W, PAD]);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    setHover((prev) => {
      const cur = prev ?? n - 1;
      return Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowRight" ? step : -step)));
    });
  };

  // End labels: skip them when the two ends are too close to separate cleanly
  // (the legend + tooltip still carry identity).
  const ends = series.map((s) => geo.y(s.values[s.values.length - 1] ?? 0));
  const endLabels = ends.length < 2 || Math.abs(ends[0]! - ends[1]!) >= 16;

  const tipLeft = hover === null ? 0 : (geo.x(hover) / W) * 100;
  const rows = [];
  for (let i = 0; i < n; i += tableStep) rows.push(i);
  if (rows[rows.length - 1] !== n - 1) rows.push(n - 1);

  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      <div className="chart-legend" aria-hidden="true">
        {series.map((s) => (
          <span key={s.key} className="chart-legend-item">
            <span className="chart-key" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {bands.map((b) => (
          <span key={b.label} className="chart-legend-item">
            <span className="chart-key chart-key-band" />
            {b.label}
          </span>
        ))}
      </div>
      <div className="chart-plot" ref={plotRef}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${h}`}
          role="img"
          aria-label={`${title}. Use left and right arrow keys to read values.`}
          aria-describedby={`${id}-tip`}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {bands.map((b) => (
            <rect
              key={b.label}
              className="chart-band"
              x={geo.x(b.from)}
              y={PAD.top}
              width={Math.max(1, geo.x(b.to) - geo.x(b.from))}
              height={h - PAD.top - PAD.bottom}
            />
          ))}
          {geo.ticks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={geo.y(t)} y2={geo.y(t)} />
              <text className="chart-axis" x={PAD.left - 8} y={geo.y(t)} textAnchor="end" dominantBaseline="middle">
                {format(t)}
              </text>
            </g>
          ))}
          {baseline !== undefined && (
            <line className="chart-baseline" x1={PAD.left} x2={W - PAD.right} y1={geo.y(baseline)} y2={geo.y(baseline)} />
          )}
          {[0, Math.floor((n - 1) / 2), n - 1].map((i) => (
            <text key={i} className="chart-axis" x={geo.x(i)} y={h - 8} textAnchor="middle">
              {xLabel(i)}
            </text>
          ))}
          {markers.map((m) => (
            <g key={`${m.at}-${m.label}`}>
              <line className="chart-marker" x1={geo.x(m.at)} x2={geo.x(m.at)} y1={PAD.top} y2={h - PAD.bottom} />
              <text className="chart-marker-label" x={geo.x(m.at) + 4} y={PAD.top + 10}>
                {m.label}
              </text>
            </g>
          ))}
          {series.map((s, k) => (
            <path key={s.key} d={geo.paths[k]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s, k) => {
            const last = s.values.length - 1;
            return (
              <g key={s.key}>
                <circle cx={geo.x(last)} cy={ends[k]} r={4} fill={s.color} className="chart-dot" />
                {endLabels && (
                  <text className="chart-end" x={geo.x(last) + 9} y={ends[k]} dominantBaseline="middle">
                    {format(s.values[last] ?? 0)}
                  </text>
                )}
              </g>
            );
          })}
          {hover !== null && (
            <g>
              <line className="chart-crosshair" x1={geo.x(hover)} x2={geo.x(hover)} y1={PAD.top} y2={h - PAD.bottom} />
              {series.map((s) => (
                <circle key={s.key} cx={geo.x(hover)} cy={geo.y(s.values[hover] ?? 0)} r={4} fill={s.color} className="chart-dot" />
              ))}
            </g>
          )}
        </svg>
        <div
          id={`${id}-tip`}
          className="chart-tip"
          role="status"
          aria-live="polite"
          style={{ left: `${tipLeft}%`, opacity: hover === null ? 0 : 1, transform: `translateX(${tipLeft > 60 ? "-105%" : "8px"})` }}
        >
          {hover !== null && (
            <>
              <div className="chart-tip-x">{xLabel(hover)}</div>
              {series.map((s) => (
                <div key={s.key} className="chart-tip-row">
                  <span className="chart-tip-key" style={{ background: s.color }} />
                  <strong>{format(s.values[hover] ?? 0)}</strong>
                  <span className="chart-tip-label">{s.label}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      <details className="chart-table">
        <summary>Show data table</summary>
        <div className="table-scroll" tabIndex={0} role="region" aria-label={`${title} data`}>
          <table>
            <thead>
              <tr>
                <th scope="col">Day</th>
                {series.map((s) => (
                  <th key={s.key} scope="col">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i}>
                  <th scope="row">{xLabel(i)}</th>
                  {series.map((s) => (
                    <td key={s.key}>{format(s.values[i] ?? 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
