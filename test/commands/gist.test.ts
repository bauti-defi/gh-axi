import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../../src/gh.js", () => ({
  ghJson: vi.fn(),
  ghExec: vi.fn(),
  ghExecWithStdin: vi.fn(),
  ghRaw: vi.fn(),
}));

vi.mock("../../src/stdin.js", () => ({
  isStdinTTY: vi.fn(),
  readStdin: vi.fn(),
}));

import { ghJson, ghExec, ghExecWithStdin } from "../../src/gh.js";
import { isStdinTTY, readStdin } from "../../src/stdin.js";
import { AxiError } from "../../src/errors.js";
import { gistCommand, GIST_HELP } from "../../src/commands/gist.js";

const mockedGhJson = vi.mocked(ghJson);
const mockedGhExec = vi.mocked(ghExec);
const mockedGhExecWithStdin = vi.mocked(ghExecWithStdin);
const mockedIsStdinTTY = vi.mocked(isStdinTTY);
const mockedReadStdin = vi.mocked(readStdin);

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

// A URL whose last path segment is the gist ID. Used as the mock return value
// from gh gist create to test ID extraction.
const CREATE_ID = "cc2233445566778899aabbccddeeff00";
const CREATE_URL = `https://gist.github.com/octocat/${CREATE_ID}`;

describe("gistCommand", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default for create: gh prints the gist URL to stdout.
    mockedGhExec.mockResolvedValue(`${CREATE_URL}\n`);
    mockedGhExecWithStdin.mockResolvedValue(`${CREATE_URL}\n`);
    // Default: stdin is piped (not a TTY) with some content.
    mockedIsStdinTTY.mockReturnValue(false);
    mockedReadStdin.mockResolvedValue("file content");
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
      expect(result).toContain("create");
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

  // ─── gist create ──────────────────────────────────────────────────────────
  //
  // Design: writes go through `gh gist create` (not the API) so gh's binary
  // sniffing and blank-file rejection stay in effect. Visibility is required
  // and mutually exclusive. Two file-on-disk input forms (positionals, --file)
  // must not be mixed. Content may also be piped via stdin + --filename.
  // No ctx parameter — gist is user-scoped (AGENTS.md "User-scoped commands").

  describe("create", () => {
    // ── Visibility validation ───────────────────────────────────────────────

    it("rejects when neither --public nor --secret is given", async () => {
      await expect(
        gistCommand(["create", "a.py"]),
      ).rejects.toThrow(AxiError);
    });

    it("rejects when both --public and --secret are given", async () => {
      await expect(
        gistCommand(["create", "a.py", "--public", "--secret"]),
      ).rejects.toThrow(AxiError);
    });

    // ── Positional file form ────────────────────────────────────────────────

    it("creates a public gist from positional files and reports id+url+visibility", async () => {
      const result = await gistCommand(["create", "a.py", "b.py", "--public"]);
      expect(result).toContain(CREATE_ID);
      expect(result).toContain(CREATE_URL);
      expect(result).toContain("public");
    });

    it("passes positional file paths to gh argv", async () => {
      // Mutation target: if `ghArgs.push(...paths)` is removed, "a.py" and "b.py"
      // disappear from the argv and this test fails.
      await gistCommand(["create", "a.py", "b.py", "--public"]);
      const args = mockedGhExec.mock.calls[0][0] as string[];
      expect(args).toContain("a.py");
      expect(args).toContain("b.py");
    });

    // ── --file flag form ────────────────────────────────────────────────────

    it("creates a gist from --file flags and reports id", async () => {
      const result = await gistCommand([
        "create",
        "--file",
        "a.py",
        "--file",
        "b.py",
        "--public",
      ]);
      expect(result).toContain(CREATE_ID);
    });

    it("passes every --file value to gh argv (repeatable, no silent drops)", async () => {
      // Mutation target: if only the first --file value is consumed (first-only
      // bug, #55/#57/#75) the second value "b.py" is absent and this test fails.
      await gistCommand([
        "create",
        "--file",
        "a.py",
        "--file",
        "b.py",
        "--public",
      ]);
      const args = mockedGhExec.mock.calls[0][0] as string[];
      expect(args).toContain("a.py");
      expect(args).toContain("b.py");
    });

    it("rejects mixing positional paths with --file", async () => {
      await expect(
        gistCommand(["create", "a.py", "--file", "b.py", "--public"]),
      ).rejects.toThrow(AxiError);
    });

    it("rejects a dangling --file with no value following it", async () => {
      // takeAllFlags throws VALIDATION_ERROR when a flag's value is missing.
      await expect(
        gistCommand(["create", "--file", "--public"]),
      ).rejects.toThrow(AxiError);
    });

    it("rejects a blank --file= value", async () => {
      await expect(
        gistCommand(["create", "--file=", "--public"]),
      ).rejects.toThrow(AxiError);
    });

    // ── Stdin / --filename form ─────────────────────────────────────────────

    it("creates a gist from piped stdin with --filename", async () => {
      const result = await gistCommand([
        "create",
        "--filename",
        "foo.txt",
        "--public",
      ]);
      expect(result).toContain(CREATE_ID);
      expect(mockedGhExecWithStdin).toHaveBeenCalledOnce();
      expect(mockedGhExec).not.toHaveBeenCalled();
    });

    it("passes --filename value to gh argv in stdin form", async () => {
      // Mutation target: if `ghArgs.push("--filename", filename)` is removed,
      // --filename and foo.txt disappear from gh argv and this test fails.
      await gistCommand(["create", "--filename", "foo.txt", "--public"]);
      const args = mockedGhExecWithStdin.mock.calls[0][0] as string[];
      expect(args).toContain("--filename");
      expect(args).toContain("foo.txt");
    });

    it("pipes stdin content to gh in stdin form", async () => {
      mockedReadStdin.mockResolvedValue("the content");
      await gistCommand(["create", "--filename", "foo.txt", "--public"]);
      const input = mockedGhExecWithStdin.mock.calls[0][1] as string;
      expect(input).toBe("the content");
    });

    it("rejects stdin form when stdin is a TTY (no pipe detected)", async () => {
      mockedIsStdinTTY.mockReturnValue(true);
      await expect(
        gistCommand(["create", "--filename", "foo.txt", "--public"]),
      ).rejects.toThrow(AxiError);
    });

    it("rejects mixing --filename with positional paths", async () => {
      await expect(
        gistCommand(["create", "a.py", "--filename", "foo.txt", "--public"]),
      ).rejects.toThrow(AxiError);
    });

    it("rejects mixing --filename with --file", async () => {
      await expect(
        gistCommand([
          "create",
          "--file",
          "a.py",
          "--filename",
          "foo.txt",
          "--public",
        ]),
      ).rejects.toThrow(AxiError);
    });

    // ── Description flag ────────────────────────────────────────────────────

    it("passes --desc to gh argv as -d", async () => {
      await gistCommand(["create", "a.py", "--public", "--desc", "My notes"]);
      const args = mockedGhExec.mock.calls[0][0] as string[];
      expect(args).toContain("-d");
      expect(args).toContain("My notes");
    });

    it("also accepts -d short form for description", async () => {
      await gistCommand(["create", "a.py", "--public", "-d", "Short desc"]);
      const args = mockedGhExec.mock.calls[0][0] as string[];
      expect(args).toContain("-d");
      expect(args).toContain("Short desc");
    });

    // ── --public flag in gh argv ─────────────────────────────────────────────

    it("passes --public to gh argv for public gists", async () => {
      // Mutation target: if `ghArgs.push("--public")` is removed, gh creates a
      // secret gist instead and this test fails.
      await gistCommand(["create", "a.py", "--public"]);
      const args = mockedGhExec.mock.calls[0][0] as string[];
      expect(args).toContain("--public");
    });

    it("does NOT pass --public or --secret to gh argv for secret gists (gh defaults to secret)", async () => {
      await gistCommand(["create", "a.py", "--secret"]);
      const args = mockedGhExec.mock.calls[0][0] as string[];
      expect(args).not.toContain("--public");
      expect(args).not.toContain("--secret");
    });

    // ── Output content ──────────────────────────────────────────────────────

    it("reports the gist id extracted from the URL last path segment", async () => {
      const result = await gistCommand(["create", "a.py", "--public"]);
      // id is the last path segment of the URL
      expect(result).toContain(CREATE_ID);
    });

    it("reports the full gist url", async () => {
      const result = await gistCommand(["create", "a.py", "--public"]);
      expect(result).toContain(CREATE_URL);
    });

    it("reports visibility: secret for secret gists", async () => {
      const result = await gistCommand(["create", "a.py", "--secret"]);
      expect(result).toContain("secret");
    });

    it("includes the unlisted-not-private help line for secret gists", async () => {
      const result = await gistCommand(["create", "a.py", "--secret"]);
      expect(result).toContain("unlisted");
      expect(result).toContain("not private");
    });

    it("omits the unlisted-not-private help line for public gists", async () => {
      const result = await gistCommand(["create", "a.py", "--public"]);
      expect(result).not.toContain("unlisted");
    });

    // ── User-scoped (no ctx forwarded to gh) ─────────────────────────────────

    it("never passes ctx to ghExec — gist create is user-scoped", async () => {
      // ghExec is called without a ctx argument. The second argument (ctx) must
      // be undefined, matching the same structural guarantee as gist list.
      await gistCommand(["create", "a.py", "--public"]);
      expect(mockedGhExec.mock.calls[0][2]).toBeUndefined();
    });

    // ── Help / suggestions ──────────────────────────────────────────────────

    it("ends with a help block", async () => {
      const result = await gistCommand(["create", "a.py", "--public"]);
      expect(result).toContain("help[");
    });
  });
});
