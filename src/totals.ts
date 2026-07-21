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

const SEARCH_TOTAL_QUERY =
  "query($q: String!) { search(query: $q, type: ISSUE) { issueCount } }";

/**
 * Build a `key:"value"` search qualifier. The value is always quoted so labels
 * and milestones containing spaces stay a single term rather than splitting
 * into a stray free-text word.
 */
export function searchQualifier(key: string, value: string): string {
  return `${key}:${JSON.stringify(value)}`;
}

/** Map a gh `--state` value onto its search qualifier; `all` has none. */
export function stateQualifiers(state: string | undefined): string[] {
  const normalized = (state ?? "open").toLowerCase();
  return normalized === "all" ? [] : [`is:${normalized}`];
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
