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
  function outcome(output: unknown, code = 0, spawnError = false) {
    (spawnPython as jest.Mock).mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      process.nextTick(() => {
        if (spawnError) { child.emit('error', new Error('spawn unavailable')); return; }
        child.stdout.write(typeof output === 'string' ? output : JSON.stringify(output));
        child.emit('close', code);
      });
      return child;
    });
  }

  it.each([0, 1])('propagates explicit rejection even with exit code %s', async code => {
    outcome({ success: false, error: 'provider rejected', publication_outcome: 'rejected' }, code);
    await expect(api.publishComment({ dynamicId: '123', content: 'text' })).rejects.toMatchObject({ publicationOutcome: 'rejected' });
  });

  it.each(['invalid JSON', { success: true }, { success: false, error: 'lost response' }])('keeps ambiguous child output unknown: %p', async output => {
    outcome(output);
    await expect(api.publishComment({ dynamicId: '123', content: 'text' })).rejects.toMatchObject({ publicationOutcome: 'unknown' });
  });

  it('classifies a failed process launch as not sent', async () => {
    outcome('', 1, true);
    await expect(api.publishComment({ dynamicId: '123', content: 'text' })).rejects.toMatchObject({ publicationOutcome: 'not_sent' });
  });

  it.each([0, 1])('notifies once for a classified credential failure with exit code %s', async code => {
    outcome({ success: false, error: 'Cookie invalid', credential_invalid: true, publication_outcome: 'not_sent' }, code);
    const notify = jest.spyOn(api as any, 'notifyCredentialIssue').mockResolvedValue(undefined);
    await expect(api.publishComment({ dynamicId: '123', content: 'text' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_ERROR', publicationOutcome: 'not_sent' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Cookie invalid'), expect.objectContaining({ dynamicId: '123' }));
  });

  it('retains a valid send receipt when refreshed credentials cannot be saved', async () => {
    outcome({ success: true, reply_id: '12345678901234567890', refreshed_credential: { sessdata: 'updated' } });
    jest.spyOn(api as any, 'persistRefreshedCredential').mockRejectedValue(new Error('disk unavailable'));
    await expect(api.publishComment({ dynamicId: '123', content: 'text' })).resolves.toMatchObject({ replyId: '12345678901234567890' });
  });

});
