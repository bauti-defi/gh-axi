import { encode } from "@toon-format/toon";
import { ghJson, ghExec, ghExecWithStdin } from "../gh.js";
import { AxiError } from "../errors.js";
import { getFlag, hasFlag, takeFlag, takeBoolFlag, takeAllFlags } from "../args.js";
import {
  field,
  custom,
  relativeTime,
  pluck,
  renderList,
  renderDetail,
  renderHelp,
  renderOutput,
  renderError,
  type FieldDef,
} from "../toon.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { parseFields, type ExtraFieldSpec } from "../fields.js";
import { isStdinTTY, readStdin } from "../stdin.js";
import { gistIdFromSelector } from "../gistSelector.js";

export const GIST_HELP = `usage: gh-axi gist <subcommand> [flags]
subcommands[5]:
  list, view <id|url>, create, delete <id|url>, clone <id|url>
flags{list}:
  --limit <n> (default 100), --public, --secret, --fields <field,...>
flags{view}:
  --files (file names only), -f/--filename <name> (single file), --full (no truncation), -r/--raw (no-op), -w/--web (rejected)
flags{create}:
  --public (required, mutually exclusive with --secret)
  --secret (required, mutually exclusive with --public)
  --file <path> (repeatable), --filename <name> (for piped content)
  -d/--desc <text>
examples:
  gh-axi gist list
  gh-axi gist list --public --limit 20
  gh-axi gist list --fields url,owner,created
  gh-axi gist view 5b0e0062eb8e9654adad7bb1d81cc75f
  gh-axi gist view https://gist.github.com/octocat/5b0e0062eb8e9654adad7bb1d81cc75f
  gh-axi gist view 5b0e0062eb8e9654adad7bb1d81cc75f --files
  gh-axi gist create notes.md --public --desc "My notes"
  gh-axi gist create --file a.py --file b.py --secret
  echo "content" | gh-axi gist create --filename hello.txt --public
  gh-axi gist delete <id|url>
  gh-axi gist clone <id|url>`;

/** Maximum items per /gists page. Also the per_page ceiling for this endpoint. */
const PAGE_SIZE = 100;

/** Always-present fields in list output (AXI P2: 3–4 fields). */
const defaultSchema: FieldDef[] = [
  field("id"),
  field("description"),
  custom("files", (item) =>
    Object.keys((item["files"] as Record<string, unknown>) ?? {}).length,
  ),
  custom("visibility", (item) => (item["public"] === true ? "public" : "secret")),
];

/** Extra fields unlocked via --fields. */
const EXTRA_FIELDS: Record<string, ExtraFieldSpec> = {
  created: { jsonKey: "created_at", def: relativeTime("created_at", "created") },
  updated: { jsonKey: "updated_at", def: relativeTime("updated_at", "updated") },
  url: { jsonKey: "html_url", def: field("html_url", "url") },
  comments: { jsonKey: "comments", def: field("comments") },
  owner: { jsonKey: "owner", def: pluck("owner", "login", "owner") },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GistFile {
  filename: string;
  type?: string;
  language?: string;
  size: number;
  content?: string;
  truncated?: boolean;
}

interface GistDetail {
  id: string;
  description: string | null;
  public: boolean;
  owner: { login: string } | null;
  files: Record<string, GistFile>;
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
}

// ---------------------------------------------------------------------------
// Content truncation (gist-specific: no prose cleanups)
// ---------------------------------------------------------------------------

/** Maximum characters shown per file in the default (non-full) view. */
const CONTENT_MAX_LEN = 1500;

/**
 * Raw head-slice truncation for gist file content.
 *
 * Unlike truncateBody, this helper applies NO prose cleanups. Gist content
 * is often source code or diffs where cleanup transforms (collapsing lines
 * starting with `>`, stripping URLs) would corrupt the content.
 * Footer is appended only when content is actually truncated (AXI P3).
 */
function truncateGistContent(
  content: string,
  maxLen: number,
  full: boolean,
): string {
  if (full || content.length <= maxLen) return content;
  return (
    content.slice(0, maxLen) +
    `\n... (truncated, ${content.length} chars total - use --full)`
  );
}

// ---------------------------------------------------------------------------
// View schemas
// ---------------------------------------------------------------------------

const gistMetaSchema: FieldDef[] = [
  field("id"),
  field("description"),
  custom("visibility", (item: GistDetail) =>
    item.public === true ? "public" : "secret",
  ),
  custom("files", (item: GistDetail) =>
    Object.keys(item.files ?? {}).length,
  ),
  relativeTime("created_at", "created"),
  relativeTime("updated_at", "updated"),
  field("comments"),
  field("html_url", "url"),
  pluck("owner", "login", "owner"),
];

function makeFileSchema(full: boolean): FieldDef[] {
  return [
    field("filename"),
    custom("size", (item: GistFile) => `${item.size} bytes`),
    custom("content", (item: GistFile) => {
      const raw = typeof item.content === "string" ? item.content : "";
      return truncateGistContent(raw, CONTENT_MAX_LEN, full);
    }),
  ];
}

// ---------------------------------------------------------------------------
// View handler
// ---------------------------------------------------------------------------

// viewGist deliberately has no ctx parameter — gist is user-scoped.
async function viewGist(args: string[]): Promise<string> {
  // Reject -w/--web up-front before consuming any other args (AXI P6).
  if (hasFlag(args, "-w") || hasFlag(args, "--web")) {
    throw new AxiError(
      "-w/--web is not supported: opening a browser is a no-op in agent contexts",
      "VALIDATION_ERROR",
    );
  }

  const full = hasFlag(args, "--full");
  const filesOnly = hasFlag(args, "--files");
  // takeFlag mutates args; consume -f before --filename to avoid double-take.
  const filenameShort = takeFlag(args, "-f");
  const filenameLong = takeFlag(args, "--filename");
  const filenameArg = filenameShort ?? filenameLong;
  // -r/--raw is documented as a no-op: output is always raw text.
  takeBoolFlag(args, "-r");
  takeBoolFlag(args, "--raw");

  // args[0] is "view"; args[1] is the selector.
  const selector = args[1];
  if (!selector || selector.startsWith("-")) {
    throw new AxiError(
      "gist view requires a gist id or URL",
      "VALIDATION_ERROR",
      ["Usage: gh-axi gist view <id|url>"],
    );
  }

  // Validate + extract bare id (throws VALIDATION_ERROR on bad input/host).
  const id = gistIdFromSelector(selector);

  // No ctx forwarded — gist is user-scoped; gh.ts#buildArgs would append
  // --repo for flag/env-sourced contexts and gh api has no --repo flag.
  const data = await ghJson<GistDetail>(["api", `/gists/${id}`]);
  const fileList = Object.values(data.files ?? {});

  const suggestions = getSuggestions({ domain: "gist", action: "view", id });

  if (filesOnly) {
    return renderOutput([
      renderList("files", fileList, [field("filename")]),
      renderHelp(suggestions),
    ]);
  }

  if (filenameArg !== undefined) {
    const file = (data.files ?? {})[filenameArg];
    if (!file) {
      const available = Object.keys(data.files ?? {}).join(", ");
      throw new AxiError(
        `File "${filenameArg}" not found in gist ${id}. Available: ${available || "(none)"}`,
        "VALIDATION_ERROR",
      );
    }
    return renderOutput([
      renderList("files", [file], makeFileSchema(full)),
      renderHelp(suggestions),
    ]);
  }

  // Default: metadata block + all files with (possibly truncated) content.
  return renderOutput([
    renderDetail("gist", data as unknown as Record<string, unknown>, gistMetaSchema),
    renderList("files", fileList, makeFileSchema(full)),
    renderHelp(suggestions),
  ]);
}

// listGists deliberately has no ctx parameter. gist is user-scoped and
// gh api /gists has no --repo flag; the guard is enforced structurally.
// See AGENTS.md "GitHub Projects" section for the owner-scoped pattern.
async function listGists(args: string[]): Promise<string> {
  const wantPublic = hasFlag(args, "--public");
  const wantSecret = hasFlag(args, "--secret");

  // Fail loudly — passing both is undefined behaviour, not a degraded result.
  if (wantPublic && wantSecret) {
    throw new AxiError(
      "--public and --secret are mutually exclusive",
      "VALIDATION_ERROR",
    );
  }

  // Let parseFields throw AxiError on unknown fields so the process exits
  // non-zero — matching every sibling command family (issue.ts:226, run.ts:207).
  const fieldsArg = getFlag(args, "--fields");
  const { extraDefs } = parseFields(fieldsArg, EXTRA_FIELDS);

  // Validate --limit before use; parseInt("abc") = NaN and slice(0, NaN) = []
  // giving a silent empty result at exit 0, which is actively wrong.
  const limitArg = getFlag(args, "--limit");
  let limit: number;
  if (limitArg !== undefined) {
    const n = parseInt(limitArg, 10);
    if (isNaN(n) || n < 1) {
      throw new AxiError(
        `--limit must be a positive integer, got: ${limitArg}`,
        "VALIDATION_ERROR",
      );
    }
    limit = n;
  } else {
    limit = PAGE_SIZE;
  }

  // --limit caps the *displayed* rows after filtering, not the fetch size.
  // When a visibility filter is active we must fetch ALL pages regardless of
  // limit — the API has no visibility filter, so we can only count matching
  // gists after receiving them. Without pagination, a --secret --limit 50 on
  // an account with 94 secret gists (and some public ones interspersed) would
  // silently stop at the first 100 API results and under-report.
  const filtering = wantPublic || wantSecret;
  const paginate = limit > PAGE_SIZE || filtering;
  const perPage = filtering ? PAGE_SIZE : Math.min(limit, PAGE_SIZE);

  const apiArgs: string[] = ["api", `/gists?per_page=${perPage}`];
  if (paginate) {
    // gh merges paginated array responses into a single valid JSON array
    // (verified on gh 2.86.0 — no concatenation issue for array endpoints).
    apiArgs.push("--paginate");
  }

  // No ctx forwarded — gist is user-scoped; gh.ts#buildArgs would append
  // --repo <nwo> for flag/env-sourced contexts and gh api has no --repo.
  const gists = await ghJson<Record<string, unknown>[]>(apiArgs);

  // Client-side visibility filter (the /gists endpoint has no visibility param).
  const filtered = wantPublic
    ? gists.filter((g) => g["public"] === true)
    : wantSecret
      ? gists.filter((g) => g["public"] !== true)
      : gists;

  // Client-side display cap applied after filtering.
  const displayed = filtered.slice(0, limit);

  const isEmpty = displayed.length === 0;
  const schema = [...defaultSchema, ...extraDefs];
  const countLine = formatCountLine({ count: displayed.length, limit });

  const suggestions = getSuggestions({ domain: "gist", action: "list", isEmpty });
  return renderOutput([
    countLine,
    renderList("gists", displayed, schema),
    renderHelp(suggestions),
  ]);
}

// deleteGist has no ctx parameter — gist is user-scoped.
// gh gist delete refuses to run non-interactively without --yes;
// always pass it so this command never prompts.
async function deleteGist(args: string[]): Promise<string> {
  const positionals = args.filter((a) => !a.startsWith("--"));
  const selector = positionals[1]; // positionals[0] == "delete"
  const extra = positionals[2];

  if (!selector)
    throw new AxiError(
      "Gist is required: gh-axi gist delete <id|url>",
      "VALIDATION_ERROR",
    );
  if (extra)
    throw new AxiError(
      `Unexpected argument: ${extra}`,
      "VALIDATION_ERROR",
    );

  await ghExec(["gist", "delete", selector, "--yes"]);
  const suggestions = getSuggestions({ domain: "gist", action: "delete" });
  return renderOutput([
    encode({ deleted: selector }),
    renderHelp(suggestions),
  ]);
}

// cloneGist has no ctx parameter — gist is user-scoped.
// Mirrors cloneRepo exactly: take the selector, shell out, report ok.
// No target-directory or git-flags passthrough — matches repo clone restraint.
async function cloneGist(args: string[]): Promise<string> {
  const positionals = args.filter((a) => !a.startsWith("--"));
  const selector = positionals[1]; // positionals[0] == "clone"
  const extra = positionals[2];

  if (!selector)
    throw new AxiError(
      "Gist is required: gh-axi gist clone <id|url>",
      "VALIDATION_ERROR",
    );
  if (extra)
    throw new AxiError(
      `Unexpected argument: ${extra}`,
      "VALIDATION_ERROR",
    );

  await ghExec(["gist", "clone", selector]);
  const suggestions = getSuggestions({ domain: "gist", action: "clone" });
  return renderOutput([
    encode({ clone: "ok", gist: selector }),
    renderHelp(suggestions),
  ]);
}

// createGist deliberately has no ctx parameter. gist is user-scoped and
// gh gist create has no --repo flag; the guard is enforced structurally.
// See AGENTS.md "User-scoped commands" section.
async function createGist(args: string[]): Promise<string> {
  // Visibility: required and mutually exclusive — check before any other work.
  const wantPublic = takeBoolFlag(args, "--public");
  const wantSecret = takeBoolFlag(args, "--secret");

  if (wantPublic && wantSecret) {
    throw new AxiError(
      "--public and --secret are mutually exclusive",
      "VALIDATION_ERROR",
    );
  }
  if (!wantPublic && !wantSecret) {
    throw new AxiError(
      "gist create requires --public or --secret; neither was given\n" +
        "A secret gist is unlisted (anyone with the URL can read it), not private.",
      "VALIDATION_ERROR",
    );
  }

  // Description: -d and --desc are aliases; take both.
  const descShort = takeFlag(args, "-d");
  const descLong = takeFlag(args, "--desc");
  const desc = descShort ?? descLong;

  // Input form flags. takeAllFlags throws VALIDATION_ERROR on dangling / blank.
  const filename = takeFlag(args, "--filename");
  const fileFlags = takeAllFlags(args, "--file");

  // After consuming all known flags, args[0] === "create" (subcommand name).
  // Anything at index 1+ is either a positional file path or an unknown flag.
  // Use startsWith("-") — not "--" — so single-dash gh shorthands (e.g. -p for
  // --public, -w for --web, -f for --filename) are rejected rather than
  // forwarded as file paths. -p is especially dangerous: it reaches gh as the
  // --public flag, creating a public gist while the wrapper reports secret.
  const remaining = args.slice(1);
  const unknownFlags = remaining.filter((a) => a.startsWith("-"));
  if (unknownFlags.length > 0) {
    throw new AxiError(
      `Unknown flag(s): ${unknownFlags.join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
  const positionals = remaining.filter((a) => !a.startsWith("-"));

  // Mixing the two file-on-disk input forms is a hard error.
  if (positionals.length > 0 && fileFlags.length > 0) {
    throw new AxiError(
      "Cannot mix positional paths with --file; use one form: " +
        "either `gist create a.py b.py` or `gist create --file a.py --file b.py`",
      "VALIDATION_ERROR",
    );
  }

  // Mixing file-on-disk with stdin/--filename is also a hard error.
  const hasFileArgs = positionals.length > 0 || fileFlags.length > 0;
  if (hasFileArgs && filename !== undefined) {
    throw new AxiError(
      "Cannot mix file paths with --filename; use one input form",
      "VALIDATION_ERROR",
    );
  }

  // At least one input source must be provided.
  if (!hasFileArgs && filename === undefined) {
    throw new AxiError(
      "gist create requires at least one file: pass positional path(s), " +
        "--file <path>, or pipe content with --filename <name>",
      "VALIDATION_ERROR",
    );
  }

  const visibility = wantPublic ? "public" : "secret";

  // Build the base gh argv. Only --public changes default visibility (gh
  // defaults to secret, so we never pass --secret to gh).
  const ghArgs = ["gist", "create"];
  if (wantPublic) ghArgs.push("--public");
  if (desc) ghArgs.push("-d", desc);

  let stdout: string;

  if (filename !== undefined) {
    // Stdin form: pipe content to gh with --filename.
    // Any condition that would make gh prompt or open $EDITOR must be caught
    // before invoking gh — an agent cannot answer a prompt.
    if (isStdinTTY()) {
      throw new AxiError(
        "--filename requires piped content on stdin; no pipe was detected",
        "VALIDATION_ERROR",
        [
          `echo 'content' | gh-axi gist create --filename <name> --public`,
        ],
      );
    }
    const content = await readStdin();
    ghArgs.push("--filename", filename);
    // No ctx — gist is user-scoped; buildArgs must not append --repo.
    stdout = await ghExecWithStdin(ghArgs, content);
  } else {
    // File form: positionals take precedence; fileFlags are translated to positionals.
    const paths = positionals.length > 0 ? positionals : fileFlags;
    ghArgs.push(...paths);
    // No ctx — gist is user-scoped; buildArgs must not append --repo.
    stdout = await ghExec(ghArgs);
  }

  // gh gist create prints only the HTML URL to stdout (status messages go to
  // stderr). Parse the id from the URL's last path segment, matching the
  // pattern used by pr create's URL → number extraction.
  const url = stdout.trim().split("\n").pop()?.trim() ?? "";
  const id = url.split("/").pop() ?? "";

  const navSuggestions = getSuggestions({ domain: "gist", action: "create", id });
  const helpLines: string[] = [];
  // Secret gists are unlisted, not private. Surface this before navigation hints
  // so the agent sees the warning even if it stops reading after the first line.
  if (visibility === "secret") {
    helpLines.push(
      "a secret gist is unlisted, not private — anyone with the URL can read it",
    );
  }
  helpLines.push(...navSuggestions);

  return renderOutput([
    renderDetail("created", { id, url, visibility }, [
      field("id"),
      field("url"),
      field("visibility"),
    ]),
    renderHelp(helpLines),
  ]);
}

// gistCommand has no ctx parameter — gist is user-scoped and ctx must never
// reach ghJson. TypeScript accepts (args: string[]) as CommandFn because
// fewer parameters are always assignable to a type with more optional params.
// See AGENTS.md "GitHub Projects" section for the owner-scoped pattern.
export async function gistCommand(args: string[]): Promise<string> {
  const sub = args[0];
  if (sub === "--help" || sub === undefined) return GIST_HELP;

  switch (sub) {
    case "list":
      return listGists(args);
    case "view":
      return viewGist(args);
    case "create":
      return createGist(args);
    case "delete":
      return deleteGist(args);
    case "clone":
      return cloneGist(args);
    default:
      return renderError(`Unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Available subcommands: list, view, create, delete, clone",
      ]);
  }
}
