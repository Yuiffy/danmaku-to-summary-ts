import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicJson, readJson } from './AdminFiles';

const nativeFs = jest.requireActual<typeof fs>('fs');
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-files-')); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('retries a temporarily locked job replacement without losing the previous state', () => {
  const file = path.join(root, 'job.json');
  atomicJson(file, { status: 'running' });
  const rename = nativeFs.renameSync;
  const wait = jest.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
  const replace = jest.spyOn(nativeFs, 'renameSync').mockImplementationOnce(() => {
    expect(readJson(file)).toEqual({ status: 'running' });
    throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
  }).mockImplementationOnce(() => { throw Object.assign(new Error('still locked'), { code: 'EBUSY' }); })
    .mockImplementation(rename);
  atomicJson(file, { status: 'succeeded' });
  expect(readJson(file)).toEqual({ status: 'succeeded' });
  expect(replace).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
  expect(fs.readdirSync(root)).toEqual(['job.json']);
});

it.each([['EACCES', 5], ['EIO', 1]])('bounds replacement failures for %s and preserves the old JSON', (code, attempts) => {
  const file = path.join(root, 'job.json');
  atomicJson(file, { status: 'running' });
  jest.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
  const failure = Object.assign(new Error('replacement failed'), { code });
  const replace = jest.spyOn(nativeFs, 'renameSync').mockImplementation(() => { throw failure; });
  expect(() => atomicJson(file, { status: 'succeeded' })).toThrow(failure);
  expect(replace).toHaveBeenCalledTimes(attempts);
  expect(readJson(file)).toEqual({ status: 'running' });
  expect(fs.readdirSync(root)).toEqual(['job.json']);
});
