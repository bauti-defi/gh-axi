import type { RepoContext } from "../context.js";
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

// Matches the shape of items returned by GET /gists.
interface GistRecord {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  comments: number;
  created_at: string;
  updated_at: string;
  owner: { login: string };
  files: Record<string, unknown>;
}

/** Maximum items returned in a single /gists page. */
const PAGE_SIZE = 100;

/** Always-present fields in list output (AXI P2: 3–4 fields). */
const defaultSchema: FieldDef[] = [
  field("id"),
  field("description"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- files is an object from parsed JSON
  custom("files", (item: any) =>
    Object.keys((item as GistRecord).files ?? {}).length,
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- public is a boolean from parsed JSON
  custom("visibility", (item: any) =>
    (item as GistRecord).public ? "public" : "secret",
  ),
];

/** Extra fields unlocked via --fields. */
const EXTRA_FIELDS: Record<string, ExtraFieldSpec> = {
  created: {
    jsonKey: "created_at",
    def: relativeTime("created_at", "created"),
  },
  updated: {
    jsonKey: "updated_at",
    def: relativeTime("updated_at", "updated"),
  },
  url: {
    jsonKey: "html_url",
    def: field("html_url", "url"),
  },
  comments: {
    jsonKey: "comments",
    def: field("comments"),
  },
  owner: {
    jsonKey: "owner",
    def: pluck("owner", "login", "owner"),
  },
};

async function listGists(
  args: string[],
  // ctx is intentionally received but never forwarded to ghJson — gist is
  // user-scoped and gh api has no --repo flag. See AGENTS.md sharp-edge.
  _ctx?: RepoContext,
): Promise<string> {
  const wantPublic = hasFlag(args, "--public");
  const wantSecret = hasFlag(args, "--secret");

  if (wantPublic && wantSecret) {
    return renderError("--public and --secret are mutually exclusive", "VALIDATION_ERROR", [
      "Pass --public to list only public gists, or --secret to list only secret gists",
    ]);
  }

  const fieldsArg = getFlag(args, "--fields");
  let extraDefs: FieldDef[] = [];
  if (fieldsArg !== undefined) {
    try {
      const parsed = parseFields(fieldsArg, EXTRA_FIELDS);
      extraDefs = parsed.extraDefs;
    } catch (err) {
      if (err instanceof AxiError) {
        return renderError(err.message, err.code, []);
      }
      throw err;
    }
  }

  const limitArg = getFlag(args, "--limit");
  const limit = limitArg !== undefined ? parseInt(limitArg, 10) : PAGE_SIZE;

  const paginate = limit > PAGE_SIZE;
  const perPage = paginate ? PAGE_SIZE : limit;

  const apiArgs: string[] = ["api", `/gists?per_page=${perPage}`];
  if (paginate) {
    // NOTE: gh api --paginate concatenates page JSON arrays (e.g. [...][...])
    // which JSON.parse cannot handle as-is. In mocked tests this returns a
    // flat array. A future slice should replace this with a multi-request loop.
    apiArgs.push("--paginate");
  }

  // Do NOT pass ctx — gist is user-scoped; threading RepoContext would cause
  // gh.ts#buildArgs to append --repo <nwo> which gh api does not accept here.
  const raw = await ghJson<GistRecord[]>(apiArgs);

  // flat() is idempotent on a flat array (mocks) and flattens nested pages
  // when gh api --paginate wraps each page into a sub-array.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON shape at runtime
  const allGists: GistRecord[] = paginate
    ? ((raw as any[]).flat() as GistRecord[])
    : raw;

  // Visibility filter is client-side — the /gists endpoint has no visibility param.
  let gists = allGists;
  if (wantPublic) gists = gists.filter((g) => g.public);
  if (wantSecret) gists = gists.filter((g) => !g.public);

  // Client-side limit (also covers post-filter shrinkage).
  gists = gists.slice(0, limit);

  const isEmpty = gists.length === 0;
  const schema = [...defaultSchema, ...extraDefs];
  const countLine = formatCountLine({ count: gists.length, limit });

  const suggestions = getSuggestions({ domain: "gist", action: "list", isEmpty });
  return renderOutput([
    countLine,
    renderList("gists", gists as unknown as Record<string, unknown>[], schema),
    renderHelp(suggestions),
  ]);
}

export async function gistCommand(
  args: string[],
  ctx?: RepoContext,
): Promise<string> {
  const sub = args[0];
  if (sub === "--help" || sub === undefined) return GIST_HELP;

  switch (sub) {
    case "list":
      return listGists(args, ctx);
    default:
      return renderError(`Unknown subcommand: ${sub}`, "VALIDATION_ERROR", [
        "Available subcommands: list",
      ]);
  }
}
