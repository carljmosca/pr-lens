import { billingOrgGraph } from "@coldtea/pr-lens-schema/examples";
import { describe, expect, it } from "vitest";
import { LANE_TOP, TABLE_ROW_HEIGHT } from "../src/design.js";
import type { Box, Point } from "../src/geometry.js";
import { layoutDataModel, routeRelations, type DataModelLayout } from "../src/layout/datamodel.js";
import { resolveScope } from "../src/scope.js";

const graph = resolveScope(billingOrgGraph, { kind: "all" });
const layout: DataModelLayout = layoutDataModel(graph);
const routed = routeRelations(layout, graph.relations);

const tableBox = (id: string): Box => {
  const placed = layout.tables.find((table) => table.table.id === id);
  if (placed === undefined) throw new Error(`no table '${id}'`);
  return placed.box;
};

/** A straight leg between two corners passes through a box's interior. */
const legCrosses = (a: Point, b: Point, box: Box): boolean => {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  return left < box.x + box.width && right > box.x && top < box.y + box.height && bottom > box.y;
};

describe("relations route around the tables", () => {
  it("never crosses a table the relation does not end on", () => {
    for (const route of routed) {
      const ends = new Set([route.relation.from.table, route.relation.to.table]);
      for (const placed of layout.tables) {
        if (ends.has(placed.table.id)) continue;
        route.waypoints.forEach((point, index) => {
          const previous = route.waypoints[index - 1];
          if (previous === undefined) return;
          expect(
            legCrosses(previous, point, placed.box),
            `${route.relation.id} crosses ${placed.table.id}`,
          ).toBe(false);
        });
      }
    }
  });

  it("crosses above the lanes to skip one", () => {
    const skip = routed.find(({ relation }) => relation.id === "subscription-user");
    const top = Math.min(...(skip?.waypoints.map(({ y }) => y) ?? []));
    expect(top).toBeLessThan(layout.laneTop);
    expect(layout.laneTop).toBeGreaterThan(LANE_TOP);
    expect(skip?.pill?.y).toBeLessThan(layout.laneTop);
  });

  it("steps out beside its own lane for a key within it", () => {
    const own = routed.find(({ relation }) => relation.id === "invoice-subscription");
    const billing = tableBox("invoice");
    const xs = own?.waypoints.map(({ x }) => x) ?? [];
    expect(Math.min(...xs)).toBeLessThan(billing.x);
  });

  it("fans arrows that land on one column within its row", () => {
    const ys = routed
      .filter(({ relation }) => relation.to.table === "user" && relation.to.column === "id")
      .map(({ waypoints }) => waypoints[waypoints.length - 1]?.y ?? 0);
    expect(new Set(ys).size).toBe(ys.length);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(TABLE_ROW_HEIGHT);
  });

  it("gives every column a row inside its card", () => {
    for (const placed of layout.tables)
      for (const { centre } of placed.columns) {
        expect(centre).toBeGreaterThan(placed.box.y);
        expect(centre).toBeLessThan(placed.box.y + placed.box.height);
      }
  });
});
