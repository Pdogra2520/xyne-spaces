jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../services/storage', () => ({ storageService: {} }));
jest.mock('../../database/client', () => ({ db: {} }));
jest.mock('@/config/env', () => ({ config: { uploads: { archiveScreening: 'shadow' } } }));
jest.mock('@xyne/shared', () => ({ AttachmentUploadStatus: {}, isHeicBuffer: () => false }));

import { classifyUpload } from '../upload';

describe('classifyUpload', () => {
  it('allows .sarif (static-analysis results, plain JSON)', () => {
    expect(classifyUpload('application/octet-stream', 'report.sarif')).toBe('allowed');
    expect(classifyUpload('application/json', 'Scan.SARIF')).toBe('allowed');
    expect(classifyUpload('application/sarif+json', 'codeql-results.sarif')).toBe('allowed');
  });

  it('keeps allowing existing data formats', () => {
    expect(classifyUpload('application/json', 'report.sarif.json')).toBe('allowed');
    expect(classifyUpload('text/plain', 'notes.md')).toBe('allowed');
  });

  it('still blocks executables and refuses unknown extensions', () => {
    expect(classifyUpload('application/octet-stream', 'a.exe')).toBe('blocked');
    expect(classifyUpload('application/x-msdownload', 'report.sarif')).toBe('blocked');
    expect(classifyUpload('application/octet-stream', 'x.xyz')).toBe('not-allowlisted');
  });
});
