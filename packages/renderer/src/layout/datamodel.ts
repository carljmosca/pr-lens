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

/** How many relations cross above the lanes: the band the lanes have to leave for them. */
const skipCount = (graph: ScopedGraph, lanes: ReadonlyMap<string, number>): number =>
  graph.relations.filter(
    ({ from, to }) => Math.abs((lanes.get(from.table) ?? 0) - (lanes.get(to.table) ?? 0)) > 1,
  ).length;

export const layoutDataModel = (graph: ScopedGraph): DataModelLayout => {
  const stores = orderStores(graph.stores);
  const lanes = laneOf(graph.tables, stores);
  const skips = skipCount(graph, lanes);
  const overBand = skips === 0 ? 0 : skips * OVER_PITCH + OVER_CLEARANCE;
  const laneTop = LANE_TOP + overBand;
  const contentTop = CONTENT_TOP + overBand;
  const laneBoxWidth = LANE_CONTENT_WIDTH + LANE_PADDING_X * 2;

  const tables: PlacedTable[] = [];
  let laneBottom = contentTop;
  stores.forEach((store, laneIndex) => {
    const x = DIAGRAM_MARGIN + laneIndex * (laneBoxWidth + LANE_GAP) + LANE_PADDING_X;
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
      x: DIAGRAM_MARGIN + index * (laneBoxWidth + LANE_GAP),
      y: laneTop,
      width: laneBoxWidth,
      height: laneBottom - laneTop,
    },
  }));

  const gutter = LANE_PADDING_X * 2 + LANE_GAP;
  const corridors = placedStores.map(({ box }) => ({
    left: box.x + LANE_PADDING_X - gutter,
    right: box.x + LANE_PADDING_X,
  }));
  const lastContentRight = (placedStores[placedStores.length - 1]?.box.x ?? DIAGRAM_MARGIN) + LANE_PADDING_X + LANE_CONTENT_WIDTH;
  corridors.push({ left: lastContentRight, right: lastContentRight + gutter });

  return {
    width: Math.ceil(DIAGRAM_MARGIN * 2 + stores.length * laneBoxWidth + Math.max(0, stores.length - 1) * LANE_GAP),
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
  from: { x: number; y: number; side: "left" | "right" };
  to: { x: number; y: number; side: "left" | "right" };
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

const faceX = (box: Box, side: "left" | "right"): number => (side === "left" ? box.x : box.x + box.width);

/**
 * Where each route goes, before any track is chosen. A neighbouring lane is
 * reached through the corridor between; the same lane steps out into the
 * corridor beside it and back; a lane further away is crossed above the lanes.
 */
const plan = (layout: DataModelLayout, relation: Relation): Plan | undefined => {
  const from = portOf(layout, relation.from.table, relation.from.column);
  const to = portOf(layout, relation.to.table, relation.to.column);
  if (from === undefined || to === undefined) return undefined;

  const la = from.table.laneIndex;
  const lb = to.table.laneIndex;
  const last = layout.stores.length - 1;
  const base = { relation, over: undefined };

  if (la === lb) {
    // ponytail: the corridor to the right, or the left for the last lane; a one-lane
    // diagram with many self-keys gets a busy corridor, widen it when that shows.
    const corridor = la < last ? la + 1 : la;
    const side = corridor === la + 1 ? "right" : "left";
    return {
      ...base,
      from: { x: faceX(from.table.box, side), y: from.row.centre, side },
      to: { x: faceX(to.table.box, side), y: to.row.centre, side },
      corridors: [corridor],
    };
  }

  const rightward = la < lb;
  const fromSide = rightward ? "right" : "left";
  const toSide = rightward ? "left" : "right";
  const ends = {
    from: { x: faceX(from.table.box, fromSide), y: from.row.centre, side: fromSide },
    to: { x: faceX(to.table.box, toSide), y: to.row.centre, side: toSide },
  } as const;

  if (Math.abs(la - lb) === 1) return { ...base, ...ends, corridors: [Math.max(la, lb)] };

  return {
    ...base,
    ...ends,
    corridors: rightward ? [la + 1, lb] : [la, lb + 1],
    over: 0,
  };
};

const spread = (left: number, right: number, count: number): number[] => {
  const room = right - left - TRACK_CLEARANCE * 2;
  // ponytail: a corridor fuller than its floor allows keeps the floor pitch and
  // overflows its clearance; the architecture lens widens lanes instead.
  const pitch = count < 2 ? 0 : Math.max(TRACK_PITCH_MIN, Math.min(TRACK_PITCH_MAX, room / (count - 1)));
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
