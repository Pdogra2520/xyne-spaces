import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();

vi.mock('./clients/apiClient', () => ({
  apiInstance: {
    post: (url: string, body: unknown): Promise<unknown> => post(url, body) as Promise<unknown>,
  },
}));

const { executeFallbackQuery } = await import('./zeroFallbackClient');

interface PostBody {
  queries: { name: string; args?: unknown }[];
}

function bodyOf(call: unknown[]): PostBody {
  return call[1] as PostBody;
}

describe('executeFallbackQuery', () => {
  beforeEach(() => {
    post.mockReset();
  });

  it('coalesces same-tick callers into a single request', async () => {
    post.mockResolvedValue({
      data: {
        results: [
          { name: 'getUsersV2', data: [{ id: 'u1' }] },
          { name: 'userAllChannels', data: [{ id: 'c1' }] },
        ],
      },
    });

    const [users, channels] = await Promise.all([
      executeFallbackQuery('getUsersV2', undefined),
      executeFallbackQuery('userAllChannels', undefined),
    ]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(bodyOf(post.mock.calls[0]!).queries.map(q => q.name)).toEqual([
      'getUsersV2',
      'userAllChannels',
    ]);
    expect(users).toEqual([{ id: 'u1' }]);
    expect(channels).toEqual([{ id: 'c1' }]);
  });

  it('matches results by name when the server answers out of order', async () => {
    post.mockResolvedValue({
      data: {
        results: [
          { name: 'userAllChannels', data: [{ id: 'c1' }] },
          { name: 'getUsersV2', data: [{ id: 'u1' }] },
        ],
      },
    });

    const [users, channels] = await Promise.all([
      executeFallbackQuery('getUsersV2', undefined),
      executeFallbackQuery('userAllChannels', undefined),
    ]);

    expect(users).toEqual([{ id: 'u1' }]);
    expect(channels).toEqual([{ id: 'c1' }]);
  });

  it('retries a failed batch one query at a time so one bad query cannot fail the rest', async () => {
    post.mockImplementation((_url: string, body: PostBody) => {
      const names = body.queries.map(q => q.name);
      if (names.length > 1) {
        return Promise.reject(new Error('batch failed'));
      }
      if (names[0] === 'broken') {
        return Promise.reject(new Error('query failed'));
      }
      return Promise.resolve({
        data: { results: [{ name: names[0], data: [{ id: 'u1' }] }] },
      });
    });

    const results = await Promise.allSettled([
      executeFallbackQuery('getUsersV2', undefined),
      executeFallbackQuery('broken', undefined),
    ]);

    expect(results[0]).toEqual({ status: 'fulfilled', value: [{ id: 'u1' }] });
    expect(results[1].status).toBe('rejected');
    // One batched attempt plus one retry per query.
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('rejects when the batch response has no slot for a query', async () => {
    post.mockResolvedValue({ data: { results: [] } });

    await expect(executeFallbackQuery('getUsersV2', undefined)).rejects.toThrow(
      'Query result not found for: getUsersV2',
    );
  });
});
