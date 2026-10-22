export type ChartPointLayout = "edges" | "centers";

export interface PriceChange {
  amount: number | null;
  percent: number | null;
}

export function nearestChartPointIndex(
  localX: number,
  width: number,
  count: number,
  layout: ChartPointLayout
): number {
  if (count <= 1 || !Number.isFinite(localX) || !Number.isFinite(width) || width <= 0) return 0;
  const clampedX = Math.min(width, Math.max(0, localX));
  const rawIndex =
    layout === "centers"
      ? Math.round((clampedX / width) * count - 0.5)
      : Math.round((clampedX / width) * (count - 1));
  return Math.min(count - 1, Math.max(0, rawIndex));
}

export function chartPointX(
  index: number,
  width: number,
  count: number,
  layout: ChartPointLayout
): number {
  if (count <= 1) return width / 2;
  return layout === "centers"
    ? (width / count) * index + width / count / 2
    : (index / (count - 1)) * width;
}

export function chartValueY(
  value: number,
  min: number,
  max: number,
  top: number,
  bottom: number
): number {
  return top + ((max - value) / (max - min || 1)) * (bottom - top);
}

export function chartBottomLabelY(height: number, inset = 6): number {
  return Math.max(0, height - inset);
}

export function priceChange(value: number, reference: number | null | undefined): PriceChange {
  if (reference == null || !Number.isFinite(reference) || reference <= 0) {
    return { amount: null, percent: null };
  }
  const amount = value - reference;
  return { amount, percent: (amount / reference) * 100 };
}
