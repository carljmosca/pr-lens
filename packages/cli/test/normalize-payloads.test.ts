import { expect, test, vi } from "vitest";
import { minimalGraph } from "@coldtea/pr-lens-schema/examples";
import { MAX_SAMPLE_BYTES, MAX_PAYLOAD_DEPTH, safeParseGraphDoc } from "@coldtea/pr-lens-schema";

import { extractGraph } from "../src/extract.js";
import { normalizePayloadSamples } from "../src/normalize-payloads.js";

const bodyWith = (payload: unknown) => ({
  ...structuredClone(minimalGraph),
  lenses: ["architecture", "data-flow"],
  nodes: [...minimalGraph.nodes, { id: "worker", label: "Worker", kind: "service", delta: "unchanged", lane: "api" }],
  flows: [{
    id: "health",
    title: "Health check",
    participants: [{ node: "health-route" }, { node: "worker" }],
    messages: [{
      id: "check",
      from: "health-route",
      to: "health-route",
      kind: "self",
      delta: "modified",
      label: "Check health",
      payload,
    }],
  }],
});

test.each(["request", "response"])("decodes sample and before on the %s side", async (side) => {
  const body = bodyWith({ [side]: { type: "Result", sample: '{"id":1}', before: '[{"id":0}]' } });
  const complete = vi.fn().mockResolvedValue(JSON.stringify(body));
  const { document, attempts } = await extractGraph({
    system: "s",
    user: "u",
    temperature: undefined,
    maxOutputTokens: 1024,
    known: {
      provenance: minimalGraph.provenance,
      lenses: ["architecture", "data-flow"],
      generatedAt: "2026-10-17T12:00:00.000Z",
      stats: { filesChanged: 1, additions: 1, deletions: 0 },
    },
  }, complete);

  expect(attempts).toBe(1);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(document.flows[0]?.messages[0]?.payload).toMatchObject({
    [side]: { sample: { id: 1 }, before: [{ id: 0 }] },
  });
});

test("normalizes samples without mutating its input", () => {
  const side = { type: "Result", sample: '{"id":1}', before: '[{"id":0}]' };
  const body = bodyWith({ request: { ...side }, response: { ...side } });
  const original = structuredClone(body);

  const normalized = normalizePayloadSamples(body);

  expect(body).toEqual(original);
  expect(normalized).toMatchObject({
    flows: [{ messages: [{ payload: {
      request: { sample: { id: 1 }, before: [{ id: 0 }] },
      response: { sample: { id: 1 }, before: [{ id: 0 }] },
    } }] }],
  });
});

test.each([null, true, false, 0, 42, { text: '{"nested":true}' }, [1, 2]])(
  "preserves inline values and decodes encoded values: %j",
  (sample) => {
    for (const input of [sample, JSON.stringify(sample)]) {
      const parsed = safeParseGraphDoc(normalizePayloadSamples(bodyWith({ request: { type: "Result", sample: input } })));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.flows[0]?.messages[0]?.payload?.request?.sample).toEqual(sample);
    }
  },
);

let deepSample: unknown = {};
for (let level = 0; level <= MAX_PAYLOAD_DEPTH; level += 1) deepSample = { nested: deepSample };

test.each([
  "not JSON",
  '{"unfinished":',
  JSON.stringify("still a string"),
  JSON.stringify(JSON.stringify({ id: 1 })),
  JSON.stringify({ text: "x".repeat(MAX_SAMPLE_BYTES) }),
  JSON.stringify(deepSample),
])("invalid samples still fail canonical validation: %s", (sample) => {
  expect(safeParseGraphDoc(normalizePayloadSamples(bodyWith({ request: { type: "Result", sample } }))).ok).toBe(false);
});

test("does not hide malformed structures, unknown keys, or missing samples", () => {
  for (const body of [
    { ...bodyWith({}), flows: "invalid" },
    { ...bodyWith({}), flows: [null, { messages: "invalid" }] },
    bodyWith({ request: { type: "Result", sample: '{"id":1}', extra: true } }),
    bodyWith({ request: { type: "Result", before: '{"id":0}' } }),
  ]) {
    expect(safeParseGraphDoc(normalizePayloadSamples(body)).ok).toBe(false);
  }
});

test("leaves absent payloads and fields absent", () => {
  expect(normalizePayloadSamples(minimalGraph)).toEqual(minimalGraph);
  expect(normalizePayloadSamples(bodyWith({ request: { type: "void" } }))).toEqual(bodyWith({ request: { type: "void" } }));
});
