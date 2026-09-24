import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RecorderXmlTail, parseXmlDanmakuLine } from './RecorderXmlTail';

describe('recorder XML fallback', () => {
  it('parses UID, text and timestamp from a recorder comment', () => {
    expect(parseXmlDanmakuLine('  <d p="1,1,25,1,1790259000000,0,1954091502,0" user="岁己">#投票 1.A 2.B &amp; C</d>'))
      .toEqual({ uid: '1954091502', text: '#投票 1.A 2.B & C', sentAt: 1790259000000 });
    expect(parseXmlDanmakuLine('<gift uid="42" />')).toBeNull();
  });

  it('starts at EOF, reads appended lines and follows rollover once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vote-xml-'));
    try {
      const folder = path.join(root, '25788785_SUI', '2026_09_24');
      await fs.mkdir(folder, { recursive: true });
      const a = path.join(folder, 'a.xml');
      await fs.writeFile(a, '<d p="1,1,25,1,1790259000000,0,1,0">old</d>\n');
      const seen: string[] = [];
      const tail = new RecorderXmlTail(root, '25788785', msg => seen.push(msg.text));
      await tail.poll();
      await fs.appendFile(a, '<d p="1,1,25,1,1790259000001,0,2,0">新');
      await tail.poll();
      expect(seen).toEqual([]);
      await fs.appendFile(a, '消息</d>\n');
      await tail.poll();
      expect(seen).toEqual(['新消息']);
      const b = path.join(folder, 'b.xml');
      await fs.writeFile(b, '<d p="1,1,25,1,1790259000002,0,3,0">next</d>\n');
      await fs.utimes(b, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
      await tail.poll();
      expect(seen).toEqual(['新消息', 'next']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
