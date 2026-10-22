import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chartBottomLabelY,
  chartPointX,
  chartValueY,
  nearestChartPointIndex,
  priceChange
} from "./chartInteraction";

describe("chart interaction", () => {
  it("snaps line charts to edge-aligned points", () => {
    assert.equal(nearestChartPointIndex(0, 100, 5, "edges"), 0);
    assert.equal(nearestChartPointIndex(49, 100, 5, "edges"), 2);
    assert.equal(nearestChartPointIndex(100, 100, 5, "edges"), 4);
    assert.equal(chartPointX(2, 100, 5, "edges"), 50);
  });

  it("snaps candle charts to column centers and clamps outside positions", () => {
    assert.equal(nearestChartPointIndex(-20, 100, 4, "centers"), 0);
    assert.equal(nearestChartPointIndex(26, 100, 4, "centers"), 1);
    assert.equal(nearestChartPointIndex(120, 100, 4, "centers"), 3);
    assert.equal(chartPointX(1, 100, 4, "centers"), 37.5);
  });

  it("maps prices to chart coordinates and calculates changes", () => {
    assert.equal(chartValueY(15, 10, 20, 10, 110), 60);
    assert.equal(chartBottomLabelY(230), 224);
    assert.deepEqual(priceChange(102, 100), { amount: 2, percent: 2 });
    assert.deepEqual(priceChange(102, null), { amount: null, percent: null });
  });
});
