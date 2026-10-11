const findUnique = jest.fn();
const findFirst = jest.fn();
const search = jest.fn();
const insert = jest.fn();

jest.mock('@/database/client', () => ({
  DatabaseClient: { getInstance: () => ({ user: { findUnique, findFirst } }) },
}));
jest.mock('@/services/vespaSearch', () => ({ vespaClient: { search, insert } }));
jest.mock('@/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { insertMemory, searchMemory } from './memoryService';
import { MemoryScope, VespaMemoryDocument } from '@/vespa/src/types';

const yqlOf = () => search.mock.calls[0][0].yql as string;
const req = (scope: MemoryScope) => ({ query: '', scope, limit: 20, offset: 0 });

describe('searchMemory tenant scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    search.mockResolvedValue({ root: { children: [] } });
  });

  it("scopes 'all' to the caller's workspace", async () => {
    findUnique.mockResolvedValue({ email: 'a@x.com', workspaceId: 'ws1' });
    await searchMemory(req(MemoryScope.ALL), 'u1');
    expect(yqlOf()).toContain('workspaceId contains "ws1"');
  });

  it("scopes 'my' to the caller's workspace and email", async () => {
    findUnique.mockResolvedValue({ email: 'a@x.com', workspaceId: 'ws1' });
    await searchMemory(req(MemoryScope.MY), 'u1');
    expect(yqlOf()).toContain('workspaceId contains "ws1"');
    expect(yqlOf()).toContain('userId contains "a@x.com"');
  });

  it('rejects a caller that does not resolve to a workspace', async () => {
    findUnique.mockResolvedValue(null);
    await expect(searchMemory(req(MemoryScope.ALL), 'ghost')).rejects.toThrow();
    await expect(searchMemory(req(MemoryScope.MY), 'ghost')).rejects.toThrow();
    await expect(searchMemory(req(MemoryScope.ALL), '')).rejects.toThrow();
    await expect(searchMemory(req(MemoryScope.ALL), { workspaceId: '' })).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });

  it('scopes internal callers to the workspace they pass', async () => {
    await searchMemory(req(MemoryScope.ALL), { workspaceId: 'ws2' });
    expect(findUnique).not.toHaveBeenCalled();
    expect(yqlOf()).toContain('workspaceId contains "ws2"');
  });

  it("rejects 'my' for internal callers", async () => {
    await expect(searchMemory(req(MemoryScope.MY), { workspaceId: 'ws2' })).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
  });
});

describe('insertMemory tenant stamp', () => {
  const doc = () =>
    ({ docId: 'd1', userId: 'a@x.com', workspaceId: 'forged', orgId: 'forged' }) as VespaMemoryDocument;

  beforeEach(() => jest.clearAllMocks());

  it('stamps the workspace given by the caller', async () => {
    await insertMemory(doc(), 'ws1');
    expect(findFirst).not.toHaveBeenCalled();
    expect(insert.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws1' });
    expect(insert.mock.calls[0][0]).not.toHaveProperty('orgId');
  });

  it("falls back to the owner's workspace", async () => {
    findFirst.mockResolvedValue({ workspaceId: 'ws3' });
    await insertMemory(doc());
    expect(insert.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws3' });
  });

  it('rejects an owner with no workspace', async () => {
    findFirst.mockResolvedValue(null);
    await expect(insertMemory(doc())).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });
});
