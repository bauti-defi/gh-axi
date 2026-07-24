import { ghJson } from "../gh.js";
import { AxiError } from "../errors.js";
import { getFlag, hasFlag } from "../args.js";
import {
  field,
  custom,
  relativeTime,
  pluck,
  renderList,
  renderHelp,
  renderOutput,
  renderError,
  type FieldDef,
} from "../toon.js";
import { formatCountLine } from "../format.js";
import { getSuggestions } from "../suggestions.js";
import { parseFields, type ExtraFieldSpec } from "../fields.js";

export const GIST_HELP = `usage: gh-axi gist <subcommand> [flags]
subcommands[1]:
  list
flags{list}:
  --limit <n> (default 100), --public, --secret, --fields <field,...>
examples:
  gh-axi gist list
  gh-axi gist list --public --limit 20
  gh-axi gist list --fields url,owner,created`;

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
  // When a visibility filter is active we must fetch a full page before
  // applying the filter; otherwise --public --limit 3 on a 10-public-gist
  // account would discard 7 matches that were never fetched.
  const filtering = wantPublic || wantSecret;
  const paginate = limit > PAGE_SIZE;
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
    default:
      return renderError(`Unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Available subcommands: list",
      ]);
  }
}
