import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  collectDiff,
  mergeBase,
  parseRemoteUrl,
  parseRepoSlug,
  providerForHost,
  pullRequestUrl,
  remoteSlug,
  resolveCommit,
} from "../src/git.js";

const sh = promisify(execFile);

test.each([
  ["git@github.com:coldteadotai/pr-lens.git", "coldteadotai", "pr-lens", "github.com", "github"],
  ["https://github.com/coldteadotai/pr-lens.git", "coldteadotai", "pr-lens", "github.com", "github"],
  ["https://github.com/coldteadotai/pr-lens", "coldteadotai", "pr-lens", "github.com", "github"],
  ["ssh://git@github.com/coldteadotai/pr-lens.git", "coldteadotai", "pr-lens", "github.com", "github"],
  ["https://gitlab.example.com/team/group/app.git", "team/group", "app", "gitlab.example.com", "gitlab"],
  ["git@gitlab.com:group/subgroup/app.git", "group/subgroup", "app", "gitlab.com", "gitlab"],
  ["https://bitbucket.org/workspace/repo.git", "workspace", "repo", "bitbucket.org", "bitbucket"],
  ["git@bitbucket.org:workspace/repo.git", "workspace", "repo", "bitbucket.org", "bitbucket"],
])("%s names a repository", (url, owner, name, host, provider) => {
  expect(parseRemoteUrl(url)).toEqual({ owner, name, host, provider });
});

test("a remote that names no repository is not guessed at", () => {
  expect(parseRemoteUrl("/srv/git/bare-repo")).toBeUndefined();
});

test("--repo-slug takes owner/name and nothing longer", () => {
  expect(parseRepoSlug("coldteadotai/pr-lens")).toEqual({
    owner: "coldteadotai",
    name: "pr-lens",
    host: "github.com",
    provider: "github",
  });
  expect(parseRepoSlug("pr-lens")).toBeUndefined();
  expect(parseRepoSlug("a/b/c")).toBeUndefined();
});

test.each([
  ["github.com", "github"],
  ["bitbucket.org", "bitbucket"],
  ["gitlab.com", "gitlab"],
  ["GitLab.example.com", "gitlab"],
  ["git.mycompany.dev", "github"],
])("%s is read as %s", (host, provider) => {
  expect(providerForHost(host)).toBe(provider);
});

test.each([
  ["github", "https://github.com/coldteadotai/pr-lens/pull/42"],
  ["gitlab", "https://gitlab.com/group/sub/app/-/merge_requests/42"],
  ["bitbucket", "https://bitbucket.org/workspace/repo/pull-requests/42"],
])("a pull request on %s gets its own URL shape", (provider, url) => {
  const slug =
    provider === "github"
      ? parseRepoSlug("coldteadotai/pr-lens")
      : parseRemoteUrl(
          provider === "gitlab"
            ? "https://gitlab.com/group/sub/app.git"
            : "https://bitbucket.org/workspace/repo.git",
        );
  expect(slug).toBeDefined();
  if (slug !== undefined) expect(pullRequestUrl(slug, 42)).toBe(url);
});

test("flag-shaped refs and remotes are rejected before reaching git", async () => {
  const root = await mkdtemp(join(tmpdir(), "pr-lens-git-"));
  try {
    await expect(resolveCommit(root, "--output=/tmp/injected")).rejects.toThrow(
      expect.objectContaining({ code: "GIT_FAILED" }),
    );
    await expect(mergeBase(root, "--all", "HEAD")).rejects.toThrow(
      expect.objectContaining({ code: "GIT_FAILED" }),
    );
    await expect(collectDiff(root, "--output=/tmp/injected", "HEAD", 1000)).rejects.toThrow(
      expect.objectContaining({ code: "GIT_FAILED" }),
    );
    expect(await remoteSlug(root, "--help")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diffing an untrusted worktree ignores core.fsmonitor and diff.external commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "pr-lens-git-safe-"));
  const marker = join(root, "ran");
  try {
    await sh("git", ["init", "--quiet"], { cwd: root });
    await sh("git", ["config", "user.name", "Test"], { cwd: root });
    await sh("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await writeFile(join(root, "file.txt"), "before\n", "utf8");
    await sh("git", ["add", "file.txt"], { cwd: root });
    await sh("git", ["commit", "-m", "first", "--quiet"], { cwd: root });
    await writeFile(join(root, "file.txt"), "after\n", "utf8");
    await sh("git", ["commit", "-am", "second", "--quiet"], { cwd: root });

    await sh("git", ["config", "core.fsmonitor", `touch ${marker}`], { cwd: root });
    await sh("git", ["config", "diff.external", `touch ${marker}`], { cwd: root });

    const base = await resolveCommit(root, "HEAD~1");
    const head = await resolveCommit(root, "HEAD");
    const diff = await collectDiff(root, base.sha, head.sha, 10_000);

    expect(diff.files).toEqual([{ path: "file.txt", additions: 1, deletions: 1 }]);
    await expect(stat(marker)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
