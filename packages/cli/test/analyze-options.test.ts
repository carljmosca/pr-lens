import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { minimalGraph } from "@coldtea/pr-lens-schema/examples";
import { run } from "../src/cli.js";
import * as git from "../src/git.js";

const Body = z.object({
  temperature: z.number().optional(),
  response_format: z.object({ type: z.literal("json_object") }).optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  { flags: [], temperature: 0, format: { type: "json_object" }, invalid: undefined },
  { flags: ["--temperature", "0.7", "--response-format", "json_object"], temperature: 0.7, format: { type: "json_object" }, invalid: undefined },
  { flags: ["--temperature", "default", "--response-format", "none"], temperature: undefined, format: undefined, invalid: undefined },
  { flags: ["--temperature", "default", "--response-format", "none"], temperature: undefined, format: undefined, invalid: '{"title":"cut off"' },
  { flags: ["--temperature", "default", "--response-format", "none"], temperature: undefined, format: undefined, invalid: JSON.stringify({ ...minimalGraph, nodes: [] }) },
])("analyze forwards $flags and repairs $invalid", async ({ flags, temperature, format, invalid }) => {
  vi.spyOn(git, "resolveCommit").mockImplementation(async (_repo, ref) => ({
    sha: ref === "main" ? "1111111" : "2222222",
    ref,
  }));
  vi.spyOn(git, "mergeBase").mockResolvedValue("1111111");
  vi.spyOn(git, "collectDiff").mockResolvedValue({
    files: [{ path: "src/health.ts", additions: 1, deletions: 0 }],
    additions: 1,
    deletions: 0,
    patch: "+health",
    truncatedAt: undefined,
  });

  const bodies: z.infer<typeof Body>[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
    const body = Body.parse(JSON.parse(String(init?.body)));
    bodies.push(body);
    expect(body.temperature).toBe(temperature);
    expect(body.response_format).toEqual(format);
    if (temperature === undefined) expect(body).not.toHaveProperty("temperature");
    if (format === undefined) expect(body).not.toHaveProperty("response_format");
    const content = bodies.length === 1 && invalid !== undefined
      ? invalid
      : `\`\`\`json\n${JSON.stringify(minimalGraph)}\n\`\`\``;
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  }));

  const root = await mkdtemp(join(tmpdir(), "pr-lens-options-"));
  try {
    const path = join(root, "graph.json");
    const errors: string[] = [];
    const code = await run([
      "analyze", "--base", "main", "--repo-slug", "example/repo", "--no-config",
      "--provider", "openai-compatible", "--base-url", "https://example.test/v1",
      "--model", "test-model", "--out", path, ...flags,
    ], { out: () => {}, err: (line) => errors.push(line) }, { OPENAI_API_KEY: "test-key" });
    expect(code, errors.join("\n")).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ title: minimalGraph.title });
    expect(bodies).toHaveLength(invalid === undefined ? 1 : 2);
    if (invalid !== undefined) {
      expect(bodies[1]?.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
      expect(errors.join("\n")).toContain("asking for a correction");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
