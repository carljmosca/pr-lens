import type { Relation, Store, Table, TableColumn } from "@coldtea/pr-lens-schema";
import {
  CARD_HEIGHT_WITH_SUBTITLE,
  CONTENT_TOP,
  DIAGRAM_MARGIN,
  ICON_MIN_CARD_WIDTH,
  LANE_BOTTOM_PADDING,
  LANE_CONTENT_WIDTH,
  LANE_GAP,
  LANE_PADDING_X,
  LANE_TOP,
  OVER_CLEARANCE,
  OVER_PITCH,
  PILL_CARD_CLEARANCE,
  PORT_FAN_MAX,
  ROW_GAP,
  TABLE_ROW_HEIGHT,
  TABLE_ROWS_PADDING_Y,
  TITLE_SIZE,
  TITLE_SIZE_SMALL,
  TRACK_CLEARANCE,
  TRACK_PITCH_MAX,
  TRACK_PITCH_MIN,
} from "../design.js";
import type { Box, Point } from "../geometry.js";
import type { ScopedGraph } from "../scope.js";
import { curveThrough, labelAnchorOf, pathOf, type Curve } from "./edges.js";
import { pillSize } from "./labels.js";

export type PlacedColumn = { column: TableColumn; top: number; centre: number };

export type PlacedTable = {
  table: Table;
  box: Box;
  titleSize: number;
  columns: PlacedColumn[];
  laneIndex: number;
};

export type PlacedStore = { store: Store; box: Box };

export type DataModelLayout = {
  width: number;
  height: number;
  stores: PlacedStore[];
  tables: PlacedTable[];
  /** Corridor `i` runs to the left of lane `i`; one more lies after the last lane. */
  corridors: { left: number; right: number }[];
  /** Where the lanes start; routes that skip a lane cross above it. */
  laneTop: number;
};

export const tableHeight = (table: Table): number =>
  CARD_HEIGHT_WITH_SUBTITLE + TABLE_ROWS_PADDING_Y * 2 + table.columns.length * TABLE_ROW_HEIGHT;

const orderStores = (stores: readonly Store[]): Store[] =>
  stores
    .map((store, index) => ({ store, index }))
    .sort(
      (a, b) =>
        (a.store.order ?? Number.MAX_SAFE_INTEGER) - (b.store.order ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .map(({ store }) => store);

const laneOf = (tables: readonly Table[], stores: readonly Store[]): Map<string, number> => {
  const index = new Map(stores.map((store, at) => [store.id, at]));
  return new Map(tables.map((table) => [table.id, index.get(table.store) ?? 0]));
};

const GUTTER = LANE_PADDING_X * 2 + LANE_GAP;

/**
 * What the routes ask of the gaps before anything is placed: how many cross
 * above the lanes, and how many legs each corridor carries. Both follow from
 * lane indices alone, so the lanes can be placed around them.
 */
const traffic = (
  graph: ScopedGraph,
  lanes: ReadonlyMap<string, number>,
  last: number,
): { skips: number; legs: Map<number, number> } => {
  const legs = new Map<number, number>();
  let skips = 0;
  for (const { from, to, label } of graph.relations) {
    const planned = planLanes(lanes.get(from.table) ?? 0, lanes.get(to.table) ?? 0, last, label);
    if (planned.over) skips += 1;
    for (const corridor of planned.corridors) legs.set(corridor, (legs.get(corridor) ?? 0) + 1);
  }
  return { skips, legs };
};

/** Room a corridor needs beyond the gutter to hold its legs at the floor pitch. */
const corridorExtra = (legs: number): number =>
  Math.max(0, TRACK_CLEARANCE * 2 + TRACK_PITCH_MIN * (legs - 1) - GUTTER);

export const layoutDataModel = (graph: ScopedGraph): DataModelLayout => {
  const stores = orderStores(graph.stores);
  const lanes = laneOf(graph.tables, stores);
  const { skips, legs } = traffic(graph, lanes, stores.length - 1);
  const overBand = skips === 0 ? 0 : skips * OVER_PITCH + OVER_CLEARANCE;
  const laneTop = LANE_TOP + overBand;
  const contentTop = CONTENT_TOP + overBand;
  const laneBoxWidth = LANE_CONTENT_WIDTH + LANE_PADDING_X * 2;
  const extra = (corridor: number): number => corridorExtra(legs.get(corridor) ?? 0);

  // Lane `i` starts after corridor `i`, and a corridor fuller than the gutter holds pushes it along.
  const laneLefts: number[] = [];
  let laneX = DIAGRAM_MARGIN;
  stores.forEach((_, laneIndex) => {
    laneX += extra(laneIndex);
    laneLefts.push(laneX);
    laneX += laneBoxWidth + LANE_GAP;
  });
  const contentRight = laneX - LANE_GAP + extra(stores.length);

  const tables: PlacedTable[] = [];
  let laneBottom = contentTop;
  stores.forEach((store, laneIndex) => {
    const x = (laneLefts[laneIndex] ?? DIAGRAM_MARGIN) + LANE_PADDING_X;
    let y = contentTop;
    for (const table of graph.tables) {
      if (table.store !== store.id) continue;
      const box = { x, y, width: LANE_CONTENT_WIDTH, height: tableHeight(table) };
      const rowsTop = y + CARD_HEIGHT_WITH_SUBTITLE + TABLE_ROWS_PADDING_Y;
      tables.push({
        table,
        box,
        titleSize: LANE_CONTENT_WIDTH >= ICON_MIN_CARD_WIDTH ? TITLE_SIZE : TITLE_SIZE_SMALL,
        columns: table.columns.map((column, index) => ({
          column,
          top: rowsTop + index * TABLE_ROW_HEIGHT,
          centre: rowsTop + index * TABLE_ROW_HEIGHT + TABLE_ROW_HEIGHT / 2,
        })),
        laneIndex,
      });
      y += box.height + ROW_GAP;
    }
    laneBottom = Math.max(laneBottom, y - ROW_GAP);
  });
  laneBottom += LANE_BOTTOM_PADDING;

  const placedStores = stores.map((store, index) => ({
    store,
    box: {
      x: laneLefts[index] ?? DIAGRAM_MARGIN,
      y: laneTop,
      width: laneBoxWidth,
      height: laneBottom - laneTop,
    },
  }));

  const corridors = placedStores.map(({ box }, index) => ({
    left: box.x + LANE_PADDING_X - GUTTER - extra(index),
    right: box.x + LANE_PADDING_X,
  }));
  const lastContentRight = (placedStores[placedStores.length - 1]?.box.x ?? DIAGRAM_MARGIN) + LANE_PADDING_X + LANE_CONTENT_WIDTH;
  corridors.push({ left: lastContentRight, right: lastContentRight + GUTTER + extra(stores.length) });

  return {
    width: Math.ceil(contentRight + DIAGRAM_MARGIN),
    height: Math.ceil(laneBottom + DIAGRAM_MARGIN),
    stores: placedStores,
    tables,
    corridors,
    laneTop,
  };
};

export type RoutedRelation = {
  relation: Relation;
  path: string;
  curve: Curve;
  /** The corners the route turns at, before they are rounded. */
  waypoints: Point[];
  /** Where the label pill sits, when the relation carries one. */
  pill: Box | undefined;
};

type Plan = {
  relation: Relation;
  from: { x: number; y: number; side: Side };
  to: { x: number; y: number; side: Side };
  /** Corridors the route runs a vertical leg in, source side first. */
  corridors: number[];
  over: number | undefined;
};

type Port = { table: PlacedTable; row: PlacedColumn };

const portOf = (layout: DataModelLayout, table: string, column: string): Port | undefined => {
  const placed = layout.tables.find((candidate) => candidate.table.id === table);
  const row = placed?.columns.find((candidate) => candidate.column.name === column);
  return placed === undefined || row === undefined ? undefined : { table: placed, row };
};

const faceX = (box: Box, side: Side): number => (side === "left" ? box.x : box.x + box.width);

/** Whether a corridor's run could carry a pill of this width without the pill crossing the cards either side. */
const pillFitsCorridor = (label: string | undefined): boolean =>
  label === undefined || pillSize(label).width + PILL_CARD_CLEARANCE * 2 <= GUTTER;

type Side = "left" | "right";

type LanePlan = {
  fromSide: Side;
  toSide: Side;
  /** Corridors the route runs a vertical leg in, source side first. */
  corridors: number[];
  over: boolean;
};

/**
 * Where a route goes, from lane indices alone. A neighbouring lane is reached
 * through the corridor between; the same lane steps out into the corridor
 * beside it and back; a lane further away is crossed above the lanes.
 *
 * A labelled relation whose pill would not fit a corridor also crosses above,
 * entering its target from the far face so the top run is a lane wide: the
 * one straight run long enough to carry its words clear of every card.
 */
const planLanes = (la: number, lb: number, last: number, label: string | undefined): LanePlan => {
  const lift = !pillFitsCorridor(label);

  if (la === lb) {
    // ponytail: the corridor to the right, or the left for the last lane; a one-lane
    // diagram with many self-keys gets a busy corridor, widen it when that shows.
    const corridor = la < last ? la + 1 : la;
    const side: Side = corridor === la + 1 ? "right" : "left";
    if (!lift) return { fromSide: side, toSide: side, corridors: [corridor], over: false };
    const farSide: Side = side === "right" ? "left" : "right";
    return { fromSide: side, toSide: farSide, corridors: [corridor, farSide === "left" ? lb : lb + 1], over: true };
  }

  const rightward = la < lb;
  const fromSide: Side = rightward ? "right" : "left";
  const nearSide: Side = rightward ? "left" : "right";

  if (Math.abs(la - lb) === 1 && !lift)
    return { fromSide, toSide: nearSide, corridors: [Math.max(la, lb)], over: false };
  if (Math.abs(la - lb) === 1)
    return { fromSide, toSide: fromSide, corridors: rightward ? [la + 1, lb + 1] : [la, lb], over: true };
  return { fromSide, toSide: nearSide, corridors: rightward ? [la + 1, lb] : [la, lb + 1], over: true };
};

const plan = (layout: DataModelLayout, relation: Relation): Plan | undefined => {
  const from = portOf(layout, relation.from.table, relation.from.column);
  const to = portOf(layout, relation.to.table, relation.to.column);
  if (from === undefined || to === undefined) return undefined;

  const lanes = planLanes(from.table.laneIndex, to.table.laneIndex, layout.stores.length - 1, relation.label);
  const end = (port: Port, side: Side) => ({ x: faceX(port.table.box, side), y: port.row.centre, side });
  return {
    relation,
    from: end(from, lanes.fromSide),
    to: end(to, lanes.toSide),
    corridors: lanes.corridors,
    over: lanes.over ? 0 : undefined,
  };
};

const spread = (left: number, right: number, count: number): number[] => {
  // The layout widened the corridor for its legs, so the pitch never falls below the floor here.
  const room = right - left - TRACK_CLEARANCE * 2;
  const pitch = count < 2 ? 0 : Math.min(TRACK_PITCH_MAX, room / (count - 1));
  const start = (left + right) / 2 - (pitch * (count - 1)) / 2;
  return Array.from({ length: count }, (_, index) => start + index * pitch);
};

export const routeRelations = (
  layout: DataModelLayout,
  relations: readonly Relation[],
): RoutedRelation[] => {
  const plans = relations.flatMap((relation) => {
    const planned = plan(layout, relation);
    return planned === undefined ? [] : [planned];
  });

  // Arrows landing on one column fan out a few pixels so each keeps its own head.
  const byTarget = new Map<string, Plan[]>();
  for (const route of plans) {
    const key = `${route.relation.to.table}\u0000${route.relation.to.column}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), route]);
  }
  const landing = new Map<Plan, number>();
  for (const group of byTarget.values()) {
    const sorted = [...group].sort((a, b) => a.from.y - b.from.y);
    const pitch = Math.min(PORT_FAN_MAX, (TABLE_ROW_HEIGHT - 2) / Math.max(1, sorted.length - 1));
    sorted.forEach((route, index) =>
      landing.set(route, route.to.y + (index - (sorted.length - 1) / 2) * pitch),
    );
  }

  // One track per vertical leg a corridor carries, ordered by where the leg lands.
  const tracks = new Map<Plan, number[]>();
  layout.corridors.forEach((corridor, index) => {
    const legs = plans
      .flatMap((route) => route.corridors.map((at, leg) => ({ route, leg, at })))
      .filter(({ at }) => at === index)
      .sort((a, b) => (landing.get(a.route) ?? 0) - (landing.get(b.route) ?? 0) || a.route.from.y - b.route.from.y);
    const xs = spread(corridor.left, corridor.right, legs.length);
    legs.forEach(({ route, leg }, position) => {
      const own = tracks.get(route) ?? [];
      own[leg] = xs[position] ?? (corridor.left + corridor.right) / 2;
      tracks.set(route, own);
    });
  });

  let overCount = 0;
  return plans.map((route): RoutedRelation => {
    const [first, second] = tracks.get(route) ?? [];
    const x1 = first ?? route.from.x;
    const landY = landing.get(route) ?? route.to.y;
    const start = { x: route.from.x, y: route.from.y };
    const end = { x: route.to.x, y: landY };

    const waypoints: Point[] =
      route.over === undefined
        ? [start, { x: x1, y: start.y }, { x: x1, y: end.y }, end]
        : (() => {
            const top = layout.laneTop - OVER_CLEARANCE - overCount * OVER_PITCH;
            overCount += 1;
            const x2 = second ?? route.to.x;
            return [start, { x: x1, y: start.y }, { x: x1, y: top }, { x: x2, y: top }, { x: x2, y: end.y }, end];
          })();

    const curve = curveThrough(waypoints);
    const label = route.relation.label;
    const pill =
      label === undefined
        ? undefined
        : (() => {
            const size = pillSize(label);
            const anchor = labelAnchorOf(curve);
            return { x: anchor.x - size.width / 2, y: anchor.y - size.height / 2, ...size };
          })();

    return { relation: route.relation, path: pathOf(curve), curve, waypoints, pill };
  });
};
