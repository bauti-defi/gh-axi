import { encode } from '@toon-format/toon';
import type { RepoContext } from '../context.js';
import { ghExec } from '../gh.js';
import { AxiError } from '../errors.js';
import { hasFlag, getFlag, getAllFlags } from '../args.js';
import { cleanBody } from '../body.js';

export const API_HELP = `usage: gh-axi api [<method>] <path>
description: Make an authenticated GitHub API request. Defaults to GET if no method specified.
methods[6]:
  GET, POST, PUT, PATCH, DELETE, HEAD
flags[5]:
  --field <key=value> (repeatable), --header <key:value> (repeatable), --paginate, --jq <expression>, --template <format>
examples:
  gh-axi api /repos/{owner}/{repo}
  gh-axi api POST /repos/{owner}/{repo}/issues --field title="Bug report"
  gh-axi api /repos/{owner}/{repo}/pulls --paginate
  gh-axi api /repos/{owner}/{repo}/issues/1 --jq '[.labels[].name]'`;

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** Flags that consume the following argument as their value. */
const VALUE_FLAGS = new Set(['--field', '--header', '--jq', '--template']);

/** Flags that stand alone and must not consume the following argument. */
const BOOL_FLAGS = new Set(['--paginate']);

/** The flag's name without any `=value` suffix, so errors never echo a value. */
function flagName(arg: string): string {
  const equals = arg.indexOf('=');
  return equals === -1 ? arg : arg.slice(0, equals);
}

/**
 * Split args into positionals, rejecting anything unrecognised.
 *
 * Unknown flags used to be skipped along with the following argument, so a flag
 * `gh-axi api` did not implement — `--jq` above all — silently vanished together
 * with its value and the caller got an unfiltered response that looked plausible.
 * Only flags known to take a value consume the next argument, which also keeps
 * `--paginate <path>` from swallowing the path.
 */
function parsePositionals(args: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const name = flagName(arg);
    if (BOOL_FLAGS.has(name)) {
      if (name !== arg)
        throw new AxiError(`${name} does not take a value`, 'VALIDATION_ERROR');
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      // `--flag=value` carries its own value; `--flag value` consumes the next arg.
      if (name === arg) {
        if (i + 1 >= args.length)
          throw new AxiError(`${name} requires a value`, 'VALIDATION_ERROR');
        i++;
      }
      continue;
    }
    throw new AxiError(
      `unknown flag ${name} for gh-axi api. Supported flags: ${[...VALUE_FLAGS, ...BOOL_FLAGS].join(', ')}`,
      'VALIDATION_ERROR',
    );
  }
  return positionals;
}

/** Maximum length for raw (non-JSON) API output before truncation. */
const RAW_OUTPUT_TRUNCATION_LIMIT = 4000;

/** Strings longer than this threshold are cleaned up (image/URL stripping). */
const LONG_STRING_CLEANUP_THRESHOLD = 200;

/** Maximum length for cleaned string values before truncation. */
const STRING_VALUE_TRUNCATION_LIMIT = 2000;


export async function apiCommand(args: string[], ctx?: RepoContext): Promise<string> {
  if (args[0] === '--help' || args.length === 0) return API_HELP;

  // Parse method and path from positional args
  const positionals = parsePositionals(args);

  let method: string;
  let path: string;

  if (positionals.length >= 2 && HTTP_METHODS.has(positionals[0].toUpperCase())) {
    method = positionals[0].toUpperCase();
    path = positionals[1];
  } else if (positionals.length >= 1) {
    method = 'GET';
    path = positionals[0];
  } else {
    throw new AxiError('API path is required: gh-axi api [<method>] <path>', 'VALIDATION_ERROR');
  }

  const ghArgs = ['api', path, '--method', method];

  const fields = getAllFlags(args, '--field');
  for (const f of fields) {
    ghArgs.push('--field', f);
  }

  const headers = getAllFlags(args, '--header');
  for (const h of headers) {
    ghArgs.push('--header', h);
  }

  if (hasFlag(args, '--paginate')) ghArgs.push('--paginate');

  const jq = getFlag(args, '--jq');
  if (jq !== undefined) ghArgs.push('--jq', jq);

  const template = getFlag(args, '--template');
  if (template !== undefined) ghArgs.push('--template', template);

  // A caller who wrote a jq expression or template already chose the exact shape
  // they want, so noisy-field stripping would silently delete fields they asked
  // for by name (`url`, `node_id`, ...).
  const callerShapedOutput = jq !== undefined || template !== undefined;

  // Try to parse as JSON, strip noisy fields, encode to TOON; fall back to raw output
  const raw = await ghExec(ghArgs, ctx);
  try {
    const data = JSON.parse(raw);
    const cleaned = callerShapedOutput ? data : stripNoisyFields(data);
    return encode(cleaned);
  } catch {
    // Not JSON — wrap in TOON envelope with truncation metadata
    const trimmed = raw.trim();
    const truncated = trimmed.length > RAW_OUTPUT_TRUNCATION_LIMIT;
    const result: Record<string, unknown> = {
      api_response: {
        body: truncated ? trimmed.slice(0, RAW_OUTPUT_TRUNCATION_LIMIT) : trimmed,
        truncated,
      },
    };
    if (truncated) {
      (result.api_response as Record<string, unknown>).original_length = trimmed.length;
    }
    return encode(result);
  }
}

/** Fields from raw GitHub API responses that are noisy/useless for agents */
const NOISY_KEYS = new Set([
  'avatar_url', 'gravatar_id', 'followers_url', 'following_url',
  'gists_url', 'starred_url', 'subscriptions_url', 'organizations_url',
  'repos_url', 'events_url', 'received_events_url', 'labels_url',
  'comments_url', 'events_url', 'timeline_url', 'performed_via_github_app',
  'node_id', 'url', 'repository_url', 'html_url',
  'reactions', 'user_view_type', 'site_admin',
  'issue_dependencies_summary', 'sub_issues_summary', 'pinned_comment',
  'score', 'permissions', 'verification', '_links',
]);

/** Keys ending in _url that are template URLs agents never use */
function isTemplateUrlKey(key: string): boolean {
  if (!key.endsWith('_url')) return false;
  // Keep a few meaningful URL keys
  const KEEP_URL_KEYS = new Set([
    'diff_url', 'patch_url', 'clone_url', 'ssh_url', 'git_url', 'svn_url',
    'commit_url', // useful for linking to specific commits
  ]);
  return !KEEP_URL_KEYS.has(key);
}

/** Collapse repo/repository objects to essential fields only */
function collapseRepo(obj: Record<string, unknown>): Record<string, unknown> {
  if ('full_name' in obj) {
    const collapsed: Record<string, unknown> = { full_name: obj.full_name };
    if (obj.default_branch) collapsed.default_branch = obj.default_branch;
    if (obj.private) collapsed.private = obj.private;
    return collapsed;
  }
  return obj;
}

function stripNoisyFields(obj: unknown, depth = 0): unknown {
  if (depth > 8) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => stripNoisyFields(item, depth + 1));
  }
  if (obj !== null && typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (NOISY_KEYS.has(key)) continue;
      if (isTemplateUrlKey(key)) continue;
      // Strip nested user objects down to just login
      if (key === 'user' && value && typeof value === 'object' && 'login' in (value as Record<string, unknown>)) {
        result[key] = (value as Record<string, unknown>).login;
        continue;
      }
      // Collapse repo/repository objects to essential fields
      if ((key === 'repo' || key === 'repository') && value && typeof value === 'object') {
        result[key] = collapseRepo(value as Record<string, unknown>);
        continue;
      }
      result[key] = stripNoisyFields(value, depth + 1);
    }
    return result;
  }
  // Clean and truncate long string values (e.g. bodies, comments)
  if (typeof obj === 'string' && obj.length > LONG_STRING_CLEANUP_THRESHOLD) {
    const s = cleanBody(obj);
    if (s.length > STRING_VALUE_TRUNCATION_LIMIT) {
      return s.slice(0, STRING_VALUE_TRUNCATION_LIMIT) + '... (truncated)';
    }
    return s;
  }
  return obj;
}
