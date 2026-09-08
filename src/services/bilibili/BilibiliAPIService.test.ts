import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { BilibiliAPIService } from './BilibiliAPIService';
import { ConfigProvider } from '../../core/config/ConfigProvider';
import { spawnPython } from '../../utils/pythonProcess';

jest.mock('../../utils/pythonProcess', () => ({ spawnPython: jest.fn() }));

describe('BilibiliAPIService comment threading', () => {
  let api: BilibiliAPIService;
  beforeEach(() => {
    jest.spyOn(ConfigProvider, 'getConfig').mockReturnValue({
      bilibili: { cookie: 'SESSDATA=test-session; bili_jct=test-csrf; DedeUserID=123;' }
    } as any);
    api = new BilibiliAPIService();
    jest.spyOn(api as any, 'refreshConfigIfChanged').mockResolvedValue(undefined);
    (spawnPython as jest.Mock).mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ success: true, reply_id: '98765432109876543210' })));
        child.emit('close', 0);
      });
      return child;
    });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

  it('passes the existing parent ID as a string after the credential payload', async () => {
    const parent = '12345678901234567890';
    const result = await api.publishComment({ dynamicId: '123', content: 'Summary', replyToId: parent });
    const args = (spawnPython as jest.Mock).mock.calls[0][0];
    expect(args).toHaveLength(9);
    expect(args[6]).toBe('');
    expect(JSON.parse(Buffer.from(args[7], 'base64').toString('utf8'))).toEqual(expect.any(Object));
    expect(args[8]).toBe(parent);
    expect(result.replyId).toBe('98765432109876543210');
  });

  it('keeps the existing positional contract for top-level and image comments', async () => {
    await api.publishComment({ dynamicId: '123', content: 'Goodnight', images: ['image.png'] });
    const args = (spawnPython as jest.Mock).mock.calls[0][0];
    expect(args).toHaveLength(8);
    expect(args[6]).toBe('image.png');
  });

  it.each(['', '0', '-1', ' 123', '1.5', '1e20', null, 123])('rejects an invalid parent ID %p rather than silently posting at top level', async replyToId => {
    await expect(api.publishComment({ dynamicId: '123', content: 'Summary', replyToId } as any))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(spawnPython).not.toHaveBeenCalled();
  });
});
