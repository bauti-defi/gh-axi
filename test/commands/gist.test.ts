import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/gh.js", () => ({
  ghJson: vi.fn(),
  ghExec: vi.fn(),
  ghRaw: vi.fn(),
}));

import { ghJson } from "../../src/gh.js";
import { gistCommand, GIST_HELP } from "../../src/commands/gist.js";
import type { RepoContext } from "../../src/context.js";

const mockedGhJson = vi.mocked(ghJson);

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

const FLAG_CTX: RepoContext = {
  nwo: "owner/name",
  owner: "owner",
  name: "name",
  source: "flag",
};

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
        gist({ id: "pub", public: true }),
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

    it("never passes repo context to gh", async () => {
      mockedGhJson.mockResolvedValue([]);
      await gistCommand(["list"], FLAG_CTX);
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
        gist({ id: "sec", public: false }),
        gist({ id: "pub", public: true }),
      ]);
      const result = await gistCommand(["list", "--public"]);
      expect(result).toContain("pub");
      expect(result).not.toContain("sec");
    });

    it("filters to secret gists with --secret", async () => {
      mockedGhJson.mockResolvedValue([
        gist({ id: "sec", public: false }),
        gist({ id: "pub", public: true }),
      ]);
      const result = await gistCommand(["list", "--secret"]);
      expect(result).toContain("sec");
      expect(result).not.toContain("pub");
    });

    it("rejects --public and --secret together", async () => {
      const result = await gistCommand(["list", "--public", "--secret"]);
      expect(result).toContain("VALIDATION_ERROR");
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
      const result = await gistCommand(["list", "--fields", "nope"]);
      expect(result).toContain("VALIDATION_ERROR");
      expect(result).toContain("nope");
    });

    it("ends with contextual help suggestions", async () => {
      mockedGhJson.mockResolvedValue([gist()]);
      const result = await gistCommand(["list"]);
      expect(result).toContain("help[");
      expect(result).toContain("gh-axi gist view");
    });

    it("shows help suggestions when no gists exist", async () => {
      mockedGhJson.mockResolvedValue([]);
      const result = await gistCommand(["list"]);
      expect(result).toContain("help[");
    });
  });
});
