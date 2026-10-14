import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminCoverPreview } from './AdminCoverPreview';

it('uses fixed renderer arguments and removes disposable previews on success or failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-preview-'));
  try {
    const run = jest.fn(async (_exe: string, args: string[]) => { fs.writeFileSync(args[args.indexOf('--output') + 1], 'jpeg'); });
    const preview = new AdminCoverPreview(root, 'configured-python', run);
    const text = "中文封面 ' $(not-a-command)";
    expect((await preview.render('registered.mp4', { time: 12.5, part: 1, text, crop: { x: .1, y: .1, width: .8, height: .8 } })).toString()).toBe('jpeg');
    expect(run.mock.calls[0]).toEqual(['configured-python', expect.arrayContaining(['registered.mp4', '--title', text, '--frame-time', '12.5', '--crop'])]);
    expect(fs.readdirSync(path.join(root, 'data/runtime/admin/cover-previews'))).toEqual([]);
    run.mockRejectedValueOnce(new Error('decode failed'));
    await expect(preview.render('registered.mp4', { time: 0, part: 1, text })).rejects.toThrow('decode failed');
    expect(fs.readdirSync(path.join(root, 'data/runtime/admin/cover-previews'))).toEqual([]);
  } finally { fs.rmSync(root, { force: true, recursive: true }); }
});
