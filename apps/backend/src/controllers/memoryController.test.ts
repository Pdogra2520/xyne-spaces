const searchMemory = jest.fn();
const getMemoryById = jest.fn();
const deleteMemory = jest.fn();
const updateMemory = jest.fn();
const replaceSession = jest.fn();
const findUnique = jest.fn();

jest.mock('@/services/memoryService', () => ({
  searchMemory,
  getMemoryById,
  deleteMemory,
  updateMemory,
  insertMemory: jest.fn(),
}));
jest.mock('@/services/vespaKnowledgeIngestionService', () => ({
  vespaKnowledgeIngestionService: { replaceSession },
}));
jest.mock('@/database/client', () => ({
  DatabaseClient: { getInstance: () => ({ user: { findUnique } }) },
}));
jest.mock('@/services/redisService', () => ({ redisService: {} }));
jest.mock('@/services/sessionHistory/sessionHistoryService', () => ({ sessionHistoryService: {} }));
jest.mock('@/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { memoryController } from './memoryController';

const user = { id: 'u1', email: 'a@x.com', workspaceId: 'ws1' };
const res = () => {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn(() => r);
  r.send = jest.fn(() => r);
  return r;
};

describe('memory controller workspace boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue(user);
  });

  const replaceReq: any = {
    user,
    body: { sessionId: 's1', reviewStatus: 'pending', docs: [] },
  };

  it("confines replaceSession to the caller's workspace", async () => {
    searchMemory.mockResolvedValue({ documents: [{ docId: 'd1', userId: '' }] });
    const r = res();
    await memoryController.replaceSessionMemory(replaceReq, r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(searchMemory).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }), 'u1');
    expect(replaceSession).toHaveBeenCalledWith('s1', 'a@x.com', [], 'ws1');
  });

  const docReq: any = { user, params: { docId: 'd1' }, body: { tags: ['t'] } };

  it('hides a doc in another workspace from update and delete, even for the same email', async () => {
    getMemoryById.mockResolvedValue({ docId: 'd1', userId: 'a@x.com', workspaceId: 'ws2' });
    const del = res();
    await memoryController.deleteMemoryDocument(docReq, del);
    expect(del.status).toHaveBeenCalledWith(404);
    expect(deleteMemory).not.toHaveBeenCalled();
    const upd = res();
    await memoryController.updateMemoryDocument(docReq, upd);
    expect(upd.status).toHaveBeenCalledWith(404);
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("lets a workspace member update and delete a teammate's doc", async () => {
    getMemoryById.mockResolvedValue({ docId: 'd1', userId: 'b@x.com', workspaceId: 'ws1' });
    updateMemory.mockResolvedValue({ docId: 'd1' });
    const upd = res();
    await memoryController.updateMemoryDocument(docReq, upd);
    expect(upd.status).toHaveBeenCalledWith(200);
    const del = res();
    await memoryController.deleteMemoryDocument(docReq, del);
    expect(del.status).toHaveBeenCalledWith(204);
    expect(deleteMemory).toHaveBeenCalledWith('d1');
  });
});
