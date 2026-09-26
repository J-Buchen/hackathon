/**
 * Direct-label placement for a chart's end labels: every label stays as close
 * to its own point as it can while no two sit closer than `gap` (px), and all
 * stay inside [lo, hi]. Labels that would collide are moved apart as a group,
 * centred on their points (the least total movement), instead of being
 * dropped, so a narrow chart still labels both lines. The order of the labels
 * never changes, so the upper label always belongs to the upper point.
 */
export function spreadLabels(ys: readonly number[], gap: number, lo = -Infinity, hi = Infinity): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  interface Cluster {
    members: Array<{ y: number; i: number }>;
    top: number;
  }
  // The best top edge for a run of labels one `gap` apart: the mean of
  // (target − its offset in the run), kept inside the bounds.
  const place = (members: Cluster["members"]): number => {
    const n = members.length;
    const mean = members.reduce((s, m, k) => s + (m.y - k * gap), 0) / n;
    const maxTop = hi - (n - 1) * gap;
    return Math.max(Math.min(mean, maxTop), Math.min(lo, maxTop));
  };
  const clusters: Cluster[] = [];
  for (const o of order) {
    clusters.push({ members: [o], top: place([o]) });
    // Merge with the run above while the two overlap.
    for (;;) {
      const b = clusters[clusters.length - 1]!;
      const a = clusters[clusters.length - 2];
      if (!a || a.top + a.members.length * gap <= b.top + 1e-9) break;
      clusters.pop();
      a.members.push(...b.members);
      a.top = place(a.members);
    }
  }
  const out = new Array<number>(ys.length);
  for (const c of clusters) c.members.forEach((m, k) => (out[m.i] = c.top + k * gap));
  return out;
}
