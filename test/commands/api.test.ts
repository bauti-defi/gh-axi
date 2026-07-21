import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/gh.js', () => ({
  ghJson: vi.fn(),
  ghExec: vi.fn(),
  ghRaw: vi.fn(),
}));

import { ghExec } from '../../src/gh.js';
import { apiCommand, API_HELP } from '../../src/commands/api.js';

const mockedGhExec = vi.mocked(ghExec);

describe('apiCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns help when --help is passed', async () => {
    const result = await apiCommand(['--help']);
    expect(result).toBe(API_HELP);
  });

  it('returns help when no args are passed', async () => {
    const result = await apiCommand([]);
    expect(result).toBe(API_HELP);
  });

  it('defaults to GET method', async () => {
    mockedGhExec.mockResolvedValue('{}');

    await apiCommand(['/repos/octo/repo']);

    expect(mockedGhExec).toHaveBeenCalledWith(
      expect.arrayContaining(['api', '/repos/octo/repo', '--method', 'GET']),
      undefined,
    );
  });

  it('uses explicit method when provided', async () => {
    mockedGhExec.mockResolvedValue('{}');

    await apiCommand(['POST', '/repos/octo/repo/issues']);

    expect(mockedGhExec).toHaveBeenCalledWith(
      expect.arrayContaining(['--method', 'POST']),
      undefined,
    );
  });

  it('passes --field flags', async () => {
    mockedGhExec.mockResolvedValue('{}');

    await apiCommand(['POST', '/repos/octo/repo/issues', '--field', 'title=Bug']);

    expect(mockedGhExec).toHaveBeenCalledWith(
      expect.arrayContaining(['--field', 'title=Bug']),
      undefined,
    );
  });

  it('passes --header flags', async () => {
    mockedGhExec.mockResolvedValue('{}');

    await apiCommand(['/repos/octo/repo', '--header', 'Accept:application/json']);

    expect(mockedGhExec).toHaveBeenCalledWith(
      expect.arrayContaining(['--header', 'Accept:application/json']),
      undefined,
    );
  });

  it('cleans JSON output by stripping noisy fields', async () => {
    mockedGhExec.mockResolvedValue(JSON.stringify({
      id: 1,
      title: 'Test issue',
      node_id: 'abc123',
      avatar_url: 'https://avatars.example.com/u/123',
      user: { login: 'alice', avatar_url: 'https://example.com', node_id: 'xyz' },
    }));

    const result = await apiCommand(['/repos/octo/repo/issues/1']);

    expect(result).toContain('Test issue');
    // node_id and avatar_url are noisy fields, should be stripped
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('avatars.example.com');
    // user should be collapsed to login
    expect(result).toContain('alice');
  });

  it('wraps non-JSON output in TOON envelope', async () => {
    mockedGhExec.mockResolvedValue('plain text response');

    const result = await apiCommand(['/some/endpoint']);

    // Should be wrapped in a TOON object, not raw text
    expect(result).toContain('api_response:');
    expect(result).toContain('plain text response');
    expect(result).toContain('truncated: false');
  });

  it('forwards --jq to gh api', async () => {
    mockedGhExec.mockResolvedValue('[]');

    await apiCommand(['/repos/octo/repo/issues/1', '--jq', '[.labels[].name]']);

    expect(mockedGhExec).toHaveBeenCalledWith(
      expect.arrayContaining(['--jq', '[.labels[].name]']),
      undefined,
    );
  });

  it('forwards --template to gh api', async () => {
    mockedGhExec.mockResolvedValue('out');

    await apiCommand(['/repos/octo/repo', '--template', '{{.name}}']);

    expect(mockedGhExec).toHaveBeenCalledWith(
      expect.arrayContaining(['--template', '{{.name}}']),
      undefined,
    );
  });

  it('does not strip fields the caller explicitly selected with --jq', async () => {
    // `url` is a noisy key by default, but selecting it by hand is deliberate.
    mockedGhExec.mockResolvedValue(JSON.stringify({ url: 'https://api.github.com/x' }));

    const result = await apiCommand(['/repos/octo/repo', '--jq', '{url: .url}']);

    expect(result).toContain('https://api.github.com/x');
  });

  it('rejects an unknown flag instead of silently ignoring it', async () => {
    await expect(apiCommand(['/repos/octo/repo', '--bogus', 'x'])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(mockedGhExec).not.toHaveBeenCalled();
  });

  it('names the offending flag without echoing its value', async () => {
    await expect(apiCommand(['/repos/octo/repo', '--token=hunter2'])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('--token'),
    });
    await expect(apiCommand(['/repos/octo/repo', '--token=hunter2'])).rejects.not.toMatchObject({
      message: expect.stringContaining('hunter2'),
    });
  });

  it('does not consume the path when --paginate precedes it', async () => {
    mockedGhExec.mockResolvedValue('{}');

    await apiCommand(['--paginate', '/repos/octo/repo/pulls']);

    expect(mockedGhExec).toHaveBeenCalledWith(
      expect.arrayContaining(['api', '/repos/octo/repo/pulls', '--paginate']),
      undefined,
    );
  });

  it('rejects a value flag with no value', async () => {
    await expect(apiCommand(['/repos/octo/repo', '--jq'])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('wraps truncated non-JSON output in TOON envelope with truncation metadata', async () => {
    const longText = 'x'.repeat(5000);
    mockedGhExec.mockResolvedValue(longText);

    const result = await apiCommand(['/some/endpoint']);

    expect(result).toContain('api_response:');
    expect(result).toContain('truncated: true');
    expect(result).toContain('original_length: 5000');
    // The body itself should be truncated
    expect(result.length).toBeLessThan(5000);
  });
});
