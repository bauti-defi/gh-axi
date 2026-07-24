/**
 * Integration tests for gist edit operations.
 *
 * These tests call real `gh` against a real GitHub gist, so they require:
 *   - `gh` installed and authenticated with the `gist` scope
 *   - Network access
 *
 * Gate: run only when GIST_INTEGRATION=1 is set in the environment.
 * Run locally: GIST_INTEGRATION=1 pnpm test test/integration/gist.integration.test.ts
 *
 * Each test asserts the real before/after gist content to catch argv bugs
 * that unit tests (with mocked gh) cannot see — exactly the class of bug
 * found in review round 2 (blocker 1: missing `-` source, blocker 2:
 * desc-only on multi-file gist, blocker 3: add-from-stdin unimplemented).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ghExec, ghExecWithStdin, ghJson } from "../../src/gh.js";

const RUN = process.env["GIST_INTEGRATION"] === "1";

// ── helpers ────────────────────────────────────────────────────────────────

interface GistFile {
  filename: string;
  content: string;
}

interface GistResponse {
  id: string;
  description: string;
  files: Record<string, GistFile>;
}

async function createGist(
  description: string,
  files: Record<string, string>,
): Promise<string> {
  // Build the argv using repeated -f flags for gh api
  const argv: string[] = ["api", "-X", "POST", "/gists", "-f", `description=${description}`];
  for (const [name, content] of Object.entries(files)) {
    argv.push("-f", `files[${name}][content]=${content}`);
  }
  const result = await ghJson<GistResponse>(argv);
  return result.id;
}

async function fetchGist(id: string): Promise<GistResponse> {
  return ghJson<GistResponse>(["api", `/gists/${id}`]);
}

async function deleteGist(id: string): Promise<void> {
  await ghExec(["api", "-X", "DELETE", `/gists/${id}`]);
}

// ── test suite ─────────────────────────────────────────────────────────────

describe.skipIf(!RUN)(
  "gist edit — integration (real gh, real gist, GIST_INTEGRATION=1)",
  () => {
    let gistId: string;

    beforeAll(async () => {
      // Create a secret scratch gist with two files so we can test multi-file
      // operations (e.g., the desc-only blocker only reproduces on multi-file gists).
      gistId = await createGist("gh-axi integration test scratch", {
        "notes.txt": "original content",
        "second.txt": "second file original",
      });
      console.log(`Created scratch gist: ${gistId}`);
    });

    afterAll(async () => {
      if (gistId) {
        await deleteGist(gistId);
        console.log(`Deleted scratch gist: ${gistId}`);
      }
    });

    it("replace file content from stdin (blocker 1 regression)", async () => {
      // Verify the '-' source positional is required and present.
      // Without '-', gh ignores piped bytes and opens $EDITOR instead.
      const before = await fetchGist(gistId);
      expect(before.files["notes.txt"]?.content).toBe("original content");

      await ghExecWithStdin(
        ["gist", "edit", gistId, "-", "--filename", "notes.txt"],
        "replaced by integration test",
      );

      const after = await fetchGist(gistId);
      console.log(
        `  notes.txt before: ${before.files["notes.txt"]?.content ?? "n/a"}`,
      );
      console.log(
        `  notes.txt after:  ${after.files["notes.txt"]?.content ?? "n/a"}`,
      );
      expect(after.files["notes.txt"]?.content).toBe(
        "replaced by integration test",
      );
    });

    it("update description only via gh api PATCH (blocker 2 regression)", async () => {
      // Verify the API PATCH route works on a multi-file gist without prompting.
      // `gh gist edit <id> --desc <text>` on a 2-file gist errors "unsure what
      // file to edit" — the API route bypasses that entirely.
      const before = await fetchGist(gistId);
      const descBefore = before.description;

      await ghExec([
        "api",
        "-X",
        "PATCH",
        `/gists/${gistId}`,
        "-f",
        "description=updated by integration test",
      ]);

      const after = await fetchGist(gistId);
      console.log(`  description before: ${descBefore}`);
      console.log(`  description after:  ${after.description}`);
      expect(after.description).toBe("updated by integration test");
    });

    it("add a new file from piped stdin (blocker 3 regression)", async () => {
      // Verify --add <name> - reads from stdin and creates a new file.
      const before = await fetchGist(gistId);
      expect(before.files["brand-new.txt"]).toBeUndefined();

      await ghExecWithStdin(
        ["gist", "edit", gistId, "--add", "brand-new.txt", "-"],
        "added from stdin by integration test",
      );

      const after = await fetchGist(gistId);
      console.log(`  brand-new.txt before: (not present)`);
      console.log(
        `  brand-new.txt after:  ${after.files["brand-new.txt"]?.content ?? "n/a"}`,
      );
      expect(after.files["brand-new.txt"]?.content).toBe(
        "added from stdin by integration test",
      );
    });

    it("remove a file", async () => {
      // Verify the remove path works.
      const before = await fetchGist(gistId);
      expect(before.files["brand-new.txt"]).toBeDefined();

      await ghExec(["gist", "edit", gistId, "--remove", "brand-new.txt"]);

      const after = await fetchGist(gistId);
      console.log(`  brand-new.txt before: (present)`);
      console.log(
        `  brand-new.txt after:  ${after.files["brand-new.txt"] === undefined ? "(removed)" : "still present"}`,
      );
      expect(after.files["brand-new.txt"]).toBeUndefined();
    });
  },
);
