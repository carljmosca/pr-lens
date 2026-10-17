import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { minimalGraph } from "@coldtea/pr-lens-schema/examples";
import { run } from "../src/cli.js";
import * as git from "../src/git.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("disabled request fields stay omitted when analyze repairs an invalid graph", async () => {
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

  const fetchMock = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
    const body: unknown = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("response_format");
    const content = fetchMock.mock.calls.length === 1
      ? JSON.stringify({ ...minimalGraph, nodes: [] })
      : `\`\`\`json\n${JSON.stringify(minimalGraph)}\n\`\`\``;
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  });
  vi.stubGlobal("fetch", fetchMock);

  const root = await mkdtemp(join(tmpdir(), "pr-lens-options-"));
  try {
    const path = join(root, "graph.json");
    const errors: string[] = [];
    const code = await run([
      "analyze", "--base", "main", "--repo-slug", "example/repo", "--no-config",
      "--provider", "openai-compatible", "--base-url", "https://example.test/v1",
      "--model", "test-model", "--out", path,
      "--temperature", "default", "--response-format", "none",
    ], { out: () => {}, err: (line) => errors.push(line) }, { OPENAI_API_KEY: "test-key" });
    expect(code, errors.join("\n")).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ title: minimalGraph.title });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errors.join("\n")).toContain("asking for a correction");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
