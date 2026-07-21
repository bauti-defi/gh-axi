/**
 * Filter-aware total counts for `issue list` and `pr list`.
 *
 * `repository.issues`/`repository.pullRequests` totalCount cannot express every
 * filter these commands accept (notably assignee/author on pull requests, and
 * `--draft` on either), so a filtered listing counted that way reports the
 * repository-wide total and reads as though the filter matched far more than it
 * did. The search API expresses all of them uniformly, so filtered listings are
 * counted there instead.
 */

import { ghRaw } from "./gh.js";
import type { RepoContext } from "./context.js";

const SEARCH_TOTAL_QUERY =
  "query($q: String!) { search(query: $q, type: ISSUE) { issueCount } }";

/**
 * Build a `key:value` search qualifier.
 *
 * Values are quoted only when they contain whitespace, so a label or milestone
 * with spaces stays a single term instead of splitting into a stray free-text
 * word. Everything else is emitted verbatim, which keeps the qualifier byte
 * identical to what the caller passed rather than JSON-escaped: search does not
 * interpret `\"` or `\\` escape sequences, so quoting values that do not need it
 * only risks mangling them.
 *
 * Sentinels such as `@me` survive either way — `assignee:@me` and
 * `assignee:"@me"` both resolve to the authenticated user (verified against the
 * live search API), so the quoting rule is about escaping, not sentinels.
 */
export function searchQualifier(key: string, value: string): string {
  return /\s/.test(value) ? `${key}:"${value}"` : `${key}:${value}`;
}

/**
 * Build one qualifier per value of a gh flag that is a Cobra stringSlice, such
 * as `--label`. gh reads `--label "bug,docs"` as two labels and requires both,
 * so it must become two ANDed qualifiers; a single `label:"bug,docs"` matches a
 * nonexistent label of that literal name.
 */
export function searchQualifiers(key: string, value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => searchQualifier(key, part));
}

/** Map a gh `--state` value onto its search qualifier; `all` has none. */
export function stateQualifiers(state: string | undefined): string[] {
  const normalized = (state ?? "open").toLowerCase();
  return normalized === "all" ? [] : [`is:${normalized}`];
}

/**
 * Whether a gh `--milestone` value can be translated into a search qualifier.
 *
 * gh accepts either a milestone number or its title, but search's `milestone:`
 * qualifier only ever matches titles, so a numeric value would silently count
 * zero. Callers skip the total entirely instead of reporting that zero.
 */
export function isSearchableMilestone(value: string): boolean {
  return !/^\d+$/.test(value);
}

/**
 * Total number of issues or pull requests matching every active filter.
 *
 * Returns undefined when the count cannot be determined, so callers fall back
 * to the limit-based "showing first N" phrasing rather than printing a number
 * that does not correspond to the query.
 */
export async function fetchSearchTotal(
  qualifiers: string[],
): Promise<number | undefined> {
  try {
    const result = await ghRaw([
      "api",
      "graphql",
      "-f",
      `query=${SEARCH_TOTAL_QUERY}`,
      "-f",
      `q=${qualifiers.join(" ")}`,
    ]);
    if (result.exitCode !== 0) return undefined;
    const parsed = JSON.parse(result.stdout);
    return parsed?.data?.search?.issueCount ?? undefined;
  } catch {
    return undefined;
  }
}

/** The `repository` connection an unfiltered listing is counted through. */
export type RepositoryEntity = "issues" | "pullRequests";

/**
 * Repository-wide total for an unfiltered listing, which is exact where search
 * is eventually consistent. Returns undefined on any failure, same as
 * {@link fetchSearchTotal}.
 */
export async function fetchRepositoryTotal(
  ctx: RepoContext,
  entity: RepositoryEntity,
  state: string | undefined,
): Promise<number | undefined> {
  try {
    const query = `{ repository(owner:"${ctx.owner}", name:"${ctx.name}") { ${entity}${statesArgument(entity, state)} { totalCount } } }`;
    const result = await ghRaw(["api", "graphql", "-f", `query=${query}`]);
    if (result.exitCode !== 0) return undefined;
    const parsed = JSON.parse(result.stdout);
    return parsed?.data?.repository?.[entity]?.totalCount ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `(states:[...])` argument list, or an empty string for `--state all`.
 * GraphQL rejects an empty argument list, so the parentheses are part of the
 * value rather than the caller's template.
 */
function statesArgument(
  entity: RepositoryEntity,
  state: string | undefined,
): string {
  const normalized = (state ?? "open").toUpperCase();
  if (normalized === "ALL") return "";
  // gh's `--state closed` covers merged pull requests too, but the GraphQL
  // enum splits them into distinct CLOSED and MERGED states.
  const states =
    entity === "pullRequests" && normalized === "CLOSED"
      ? "CLOSED,MERGED"
      : normalized;
  return `(states:[${states}])`;
}
