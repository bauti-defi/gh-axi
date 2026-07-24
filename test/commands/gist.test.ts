import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/gh.js", () => ({
  ghJson: vi.fn(),
  ghExec: vi.fn(),
  ghRaw: vi.fn(),
}));

import { ghJson, ghExec } from "../../src/gh.js";
import { AxiError } from "../../src/errors.js";
import { gistCommand, GIST_HELP } from "../../src/commands/gist.js";

const mockedGhJson = vi.mocked(ghJson);
const mockedGhExec = vi.mocked(ghExec);

function gist(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "5b0e0062eb8e9654adad7bb1d81cc75f",
    description: "a gist",
    public: false,
    html_url:
      "https://gist.github.com/octocat/5b0e0062eb8e9654adad7bb1d81cc75f",
    comments: 0,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    owner: { login: "octocat" },
    files: { "a.txt": { filename: "a.txt", size: 10 } },
    ...overrides,
  };
}

// Use hex-style IDs with no English-word substrings so toContain(id) cannot
// collide with toContain("public") / toContain("secret") or similar text.
const ID_ALPHA = "aaaa0000000000000000000000000000"; // used as the public gist
const ID_BRAVO = "bbbb1111111111111111111111111111"; // used as the secret gist

describe("gistCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("router", () => {
    it("returns help when --help is passed", async () => {
      expect(await gistCommand(["--help"])).toBe(GIST_HELP);
    });

    it("returns help when no subcommand is given", async () => {
      expect(await gistCommand([])).toBe(GIST_HELP);
    });

    it("returns a structured error for an unknown subcommand", async () => {
      const result = await gistCommand(["frobnicate"]);
      expect(result).toContain("Unknown subcommand: frobnicate");
      expect(result).toContain("list");
    });
  });

  describe("list", () => {
    it("renders gists with a count line", async () => {
      mockedGhJson.mockResolvedValue([gist(), gist({ id: "abc" })]);
      const result = await gistCommand(["list"]);
      expect(result).toContain("count:");
      expect(result).toContain("5b0e0062eb8e9654adad7bb1d81cc75f");
    });

    it("uses exactly the four default fields", async () => {
      mockedGhJson.mockResolvedValue([gist()]);
      const result = await gistCommand(["list"]);
      const header = result
        .split("\n")
        .find((l) => l.includes("gists[") && l.includes("{"));
      expect(header).toBeDefined();
      expect(header).toContain("{id,description,files,visibility}");
    });

    it("reports secret gists as secret and public as public", async () => {
      mockedGhJson.mockResolvedValue([
        gist({ public: false }),
        gist({ id: "cc0000000000000000000000000000cc", public: true }),
      ]);
      const result = await gistCommand(["list"]);
      expect(result).toContain("secret");
      expect(result).toContain("public");
    });

    it("counts files per gist", async () => {
      mockedGhJson.mockResolvedValue([
        gist({ files: { "a.txt": {}, "b.txt": {}, "c.txt": {} } }),
      ]);
      const result = await gistCommand(["list"]);
      expect(result).toMatch(/,3,/);
    });

    it("requests per_page=100 by default", async () => {
      mockedGhJson.mockResolvedValue([]);
      await gistCommand(["list"]);
      const args = mockedGhJson.mock.calls[0][0] as string[];
      expect(args[0]).toBe("api");
      expect(args.join(" ")).toContain("per_page=100");
    });

    it("never passes repo context to gh — gist is user-scoped", async () => {
      // gistCommand has no ctx parameter; the guard is structural (TypeScript
      // accepts (args: string[]) as CommandFn). We verify the contract by
      // confirming ghJson is called without a second argument regardless of
      // whatever the withRepoContext wrapper in cli.ts might supply.
      mockedGhJson.mockResolvedValue([]);
      await gistCommand(["list"]);
      expect(mockedGhJson.mock.calls[0][1]).toBeUndefined();
    });

    it("honours --limit below the page size", async () => {
      mockedGhJson.mockResolvedValue([gist(), gist({ id: "b" })]);
      const result = await gistCommand(["list", "--limit", "1"]);
      expect(result).toContain("count: 1");
    });

    it("paginates when the limit exceeds one page", async () => {
      mockedGhJson.mockResolvedValue([]);
      await gistCommand(["list", "--limit", "250"]);
      const args = mockedGhJson.mock.calls[0][0] as string[];
      expect(args).toContain("--paginate");
    });

    it("filters to public gists with --public", async () => {
      mockedGhJson.mockResolvedValue([
        gist({ id: ID_BRAVO, public: false }),
        gist({ id: ID_ALPHA, public: true }),
      ]);
      const result = await gistCommand(["list", "--public"]);
      expect(result).toContain(ID_ALPHA);
      expect(result).not.toContain(ID_BRAVO);
    });

    it("filters to secret gists with --secret", async () => {
      mockedGhJson.mockResolvedValue([
        gist({ id: ID_BRAVO, public: false }),
        gist({ id: ID_ALPHA, public: true }),
      ]);
      const result = await gistCommand(["list", "--secret"]);
      expect(result).toContain(ID_BRAVO);
      expect(result).not.toContain(ID_ALPHA);
    });

    it("rejects --public and --secret together", async () => {
      await expect(
        gistCommand(["list", "--public", "--secret"]),
      ).rejects.toThrow(AxiError);
    });

    it("gives a definitive empty state", async () => {
      mockedGhJson.mockResolvedValue([]);
      const result = await gistCommand(["list"]);
      expect(result).toContain("count: 0");
    });

    it("adds requested extra fields with --fields", async () => {
      mockedGhJson.mockResolvedValue([gist()]);
      const result = await gistCommand(["list", "--fields", "url,owner"]);
      const header = result
        .split("\n")
        .find((l) => l.includes("gists[") && l.includes("{"));
      expect(header).toBeDefined();
      expect(header).toContain("url");
      expect(header).toContain("owner");
    });

    it("rejects unknown --fields values", async () => {
      mockedGhJson.mockResolvedValue([gist()]);
      await expect(
        gistCommand(["list", "--fields", "nope"]),
      ).rejects.toThrow(AxiError);
    });

    it("ends with contextual help suggestions", async () => {
      mockedGhJson.mockResolvedValue([gist()]);
      const result = await gistCommand(["list"]);
      expect(result).toContain("help[");
      expect(result).toContain("gh-axi api /gists/");
    });

    it("shows help suggestions when no gists exist", async () => {
      mockedGhJson.mockResolvedValue([]);
      const result = await gistCommand(["list"]);
      expect(result).toContain("help[");
    });

    // Regression: --limit must cap *displayed rows after filtering*, not the
    // fetch size. With 3 secret + 1 public gist and --public --limit 2:
    //   - count must be 1 (the one public gist), not 0 (limit before filter)
    //   - per_page must be 100 (full page), not 2 (limit used as fetch size)
    //   - --paginate must be present (filtering always paginates)
    // The per_page and --paginate assertions ensure the test bites when either
    // the old perPage=Math.min(limit,PAGE_SIZE) or paginate=limit>PAGE_SIZE
    // bug is reintroduced — the count assertion alone passes even with the bug
    // if the mock returns fewer items than the buggy perPage.
    it("applies --limit after the visibility filter and fetches a full page", async () => {
      mockedGhJson.mockResolvedValue([
        gist({ id: ID_BRAVO + "0", public: false }),
        gist({ id: ID_BRAVO + "1", public: false }),
        gist({ id: ID_BRAVO + "2", public: false }),
        gist({ id: ID_ALPHA, public: true }),
      ]);
      const result = await gistCommand(["list", "--public", "--limit", "2"]);
      expect(result).toContain("count: 1");
      const capturedArgs = mockedGhJson.mock.calls[0][0] as string[];
      expect(capturedArgs.join(" ")).toContain("per_page=100");
      expect(capturedArgs).toContain("--paginate");
    });

    it("rejects a non-numeric --limit", async () => {
      mockedGhJson.mockResolvedValue([]);
      await expect(
        gistCommand(["list", "--limit", "abc"]),
      ).rejects.toThrow(AxiError);
    });

    it("rejects --limit 0", async () => {
      mockedGhJson.mockResolvedValue([]);
      await expect(
        gistCommand(["list", "--limit", "0"]),
      ).rejects.toThrow(AxiError);
    });

    it("rejects a negative --limit", async () => {
      mockedGhJson.mockResolvedValue([]);
      await expect(
        gistCommand(["list", "--limit", "-5"]),
      ).rejects.toThrow(AxiError);
    });
  });

  describe("delete", () => {
    it("deletes the gist and reports what was deleted", async () => {
      mockedGhExec.mockResolvedValue("");
      const result = await gistCommand(["delete", "abc1230000000000000000000000000a"]);
      expect(result).toContain("abc1230000000000000000000000000a");
    });

    // Mutation-test anchor: if --yes is removed from the ghExec call, the argv
    // assertion below will fail. Verified by reverting the --yes and watching
    // this test go red, then restoring.
    it("always passes --yes to gh gist delete", async () => {
      mockedGhExec.mockResolvedValue("");
      await gistCommand(["delete", "abc1230000000000000000000000000a"]);
      const capturedArgs = mockedGhExec.mock.calls[0]![0] as string[];
      expect(capturedArgs).toContain("--yes");
    });

    it("passes the selector to gh gist delete as argv", async () => {
      mockedGhExec.mockResolvedValue("");
      await gistCommand(["delete", "abc1230000000000000000000000000a"]);
      const capturedArgs = mockedGhExec.mock.calls[0]![0] as string[];
      expect(capturedArgs).toContain("abc1230000000000000000000000000a");
      expect(capturedArgs[0]).toBe("gist");
      expect(capturedArgs[1]).toBe("delete");
    });

    it("throws VALIDATION_ERROR when no selector is given", async () => {
      await expect(gistCommand(["delete"])).rejects.toThrow(AxiError);
    });

    it("throws VALIDATION_ERROR for surplus positional arguments", async () => {
      mockedGhExec.mockResolvedValue("");
      await expect(
        gistCommand(["delete", "abc1230000000000000000000000000a", "extra"]),
      ).rejects.toThrow(AxiError);
    });

    it("accepts a gist URL as the selector", async () => {
      mockedGhExec.mockResolvedValue("");
      const url = "https://gist.github.com/octocat/abc1230000000000000000000000000a";
      const result = await gistCommand(["delete", url]);
      expect(result).toContain(url);
      const capturedArgs = mockedGhExec.mock.calls[0]![0] as string[];
      expect(capturedArgs).toContain(url);
      expect(capturedArgs).toContain("--yes");
    });

    it("emits contextual help suggestions", async () => {
      mockedGhExec.mockResolvedValue("");
      const result = await gistCommand(["delete", "abc1230000000000000000000000000a"]);
      expect(result).toContain("help[");
      expect(result).toContain("gist list");
    });

    it("never passes ctx to ghExec — gist is user-scoped", async () => {
      mockedGhExec.mockResolvedValue("");
      await gistCommand(["delete", "abc1230000000000000000000000000a"]);
      expect(mockedGhExec.mock.calls[0]![1]).toBeUndefined();
    });
  });

  describe("clone", () => {
    it("clones the gist and reports ok", async () => {
      mockedGhExec.mockResolvedValue("");
      const result = await gistCommand(["clone", "abc1230000000000000000000000000a"]);
      expect(result).toContain("ok");
    });

    it("passes the selector to gh gist clone as argv", async () => {
      mockedGhExec.mockResolvedValue("");
      await gistCommand(["clone", "abc1230000000000000000000000000a"]);
      const capturedArgs = mockedGhExec.mock.calls[0]![0] as string[];
      expect(capturedArgs[0]).toBe("gist");
      expect(capturedArgs[1]).toBe("clone");
      expect(capturedArgs).toContain("abc1230000000000000000000000000a");
    });

    it("throws VALIDATION_ERROR when no selector is given", async () => {
      await expect(gistCommand(["clone"])).rejects.toThrow(AxiError);
    });

    it("throws VALIDATION_ERROR for surplus positional arguments", async () => {
      mockedGhExec.mockResolvedValue("");
      await expect(
        gistCommand(["clone", "abc1230000000000000000000000000a", "extra"]),
      ).rejects.toThrow(AxiError);
    });

    it("accepts a gist URL as the selector", async () => {
      mockedGhExec.mockResolvedValue("");
      const url = "https://gist.github.com/octocat/abc1230000000000000000000000000a";
      const result = await gistCommand(["clone", url]);
      expect(result).toContain("ok");
      const capturedArgs = mockedGhExec.mock.calls[0]![0] as string[];
      expect(capturedArgs).toContain(url);
    });

    it("emits contextual help suggestions", async () => {
      mockedGhExec.mockResolvedValue("");
      const result = await gistCommand(["clone", "abc1230000000000000000000000000a"]);
      expect(result).toContain("help[");
      expect(result).toContain("gist list");
    });

    it("never passes ctx to ghExec — gist is user-scoped", async () => {
      mockedGhExec.mockResolvedValue("");
      await gistCommand(["clone", "abc1230000000000000000000000000a"]);
      expect(mockedGhExec.mock.calls[0]![1]).toBeUndefined();
    });
  });
});
