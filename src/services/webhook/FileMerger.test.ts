import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileMerger } from './FileMerger';
import { LiveSegment } from './LiveSessionManager';
import { ProcessingAlertService } from '../monitoring/ProcessingAlertService';
import { parseStringPromise } from 'xml2js';

function makeSegment(videoPath: string, index: number): LiveSegment {
  const openedAt = new Date(2026, 0, 1, 12, index, 0);
  return {
    videoPath,
    xmlPath: videoPath.replace(/\.flv$/, '.xml'),
    fileOpenTime: openedAt,
    fileCloseTime: new Date(openedAt.getTime() + 60_000),
    eventTimestamp: openedAt
  };
}

describe('FileMerger', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-merger-'));
    jest.spyOn(ProcessingAlertService, 'notifyHighCpuAtMergeStart').mockResolvedValue(undefined);
    jest.spyOn(ProcessingAlertService, 'notifyIfSlowStage').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('writes well-formed XML including browser preview and gap-adjusted comments', async () => {
    jest.useFakeTimers();
    const merger = new FileMerger();
    jest.spyOn(merger, 'getSegmentDuration').mockResolvedValue(60);
    const first = makeSegment(path.join(tempDir, 'part1.flv'), 0);
    const second = makeSegment(path.join(tempDir, 'part2.flv'), 2);
    fs.writeFileSync(first.xmlPath, '<i><d p="1.250,1,25,16777215,1,0,7,0" user="小岁">你好</d></i>');
    fs.writeFileSync(second.xmlPath, '<i><d p="1.500,4,25,14893055,2,0,8,0" user="观众">晚安</d></i>');
    const outputPath = path.join(tempDir, 'merged.xml');

    await merger.mergeXmlFiles([first, second], outputPath);

    const xml = fs.readFileSync(outputPath, 'utf8');
    const parsed = await parseStringPromise(xml);
    expect(parsed.i.d).toEqual([
      { _: '你好', $: { p: '1.250,1,25,16777215,1,0,7,0', user: '小岁' } },
      { _: '晚安', $: { p: '121.500,4,25,14893055,2,0,8,0', user: '观众' } }
    ]);
    const preview = parsed.i.BililiveRecorderXmlStyle[0]['z:stylesheet'][0]['z:template'][0].html[0];
    expect(preview.script[0]).toContain('<a target=_blank');
    expect(parsed.i.BililiveRecorderRecordInfo[0].$.name).toBe('Merged');
  });

  test('round-trips escaped text and user names without double escaping', async () => {
    jest.useFakeTimers();
    const merger = new FileMerger();
    jest.spyOn(merger, 'getSegmentDuration').mockResolvedValue(60);
    const segment = makeSegment(path.join(tempDir, 'escaped.flv'), 0);
    fs.writeFileSync(segment.xmlPath, '<i><d p="1,1,25,16777215,1,0,7,0" user="A&amp;B &quot;小岁&quot;">1 &lt; 2 &amp; 3 &gt; 2 &quot;哇&quot; &apos;😀&apos; &amp;lt; &#x1F642; &#10;换行</d></i>');
    const outputPath = path.join(tempDir, 'merged.xml');

    await merger.mergeXmlFiles([segment], outputPath);

    // Parse entries independently so malformed preview markup cannot hide an entity regression.
    const entries = fs.readFileSync(outputPath, 'utf8').match(/<d\s+[^>]*>[^<]*<\/d>/g);
    const parsed = await parseStringPromise(`<i>${entries?.join('')}</i>`);
    expect(parsed.i.d[0]._).toBe('1 < 2 & 3 > 2 "哇" \'😀\' &lt; 🙂 \n换行');
    expect(parsed.i.d[0].$.user).toBe('A&B "小岁"');

    const secondOutput = path.join(tempDir, 'merged-again.xml');
    await merger.mergeXmlFiles([{ ...segment, xmlPath: outputPath }], secondOutput);
    const reparsed = await parseStringPromise(fs.readFileSync(secondOutput, 'utf8'));
    expect(reparsed.i.d).toEqual(parsed.i.d);
  });

  test('still reads comments from legacy XML with malformed preview script', async () => {
    jest.useFakeTimers();
    const merger = new FileMerger();
    jest.spyOn(merger, 'getSegmentDuration').mockResolvedValue(60);
    const segment = makeSegment(path.join(tempDir, 'legacy.flv'), 0);
    fs.writeFileSync(segment.xmlPath, '<i><script>let link = `<a target=_blank>link</a>`;</script><d p="1,1,25,16777215,1,0,7,0">A&amp;B</d></i>');
    const outputPath = path.join(tempDir, 'merged.xml');

    await merger.mergeXmlFiles([segment], outputPath);

    const parsed = await parseStringPromise(fs.readFileSync(outputPath, 'utf8'));
    expect(parsed.i.d).toEqual([{ _: 'A&B', $: { p: '1.000,1,25,16777215,1,0,7,0', user: '' } }]);
  });

  test('uses stream copy by default when concatenating segments', async () => {
    const merger = new FileMerger();
    const runFfmpeg = jest.spyOn(merger as any, 'runFfmpeg').mockResolvedValue(undefined);
    const outputPath = path.join(tempDir, 'merged.flv');

    await merger.mergeVideos([
      makeSegment(path.join(tempDir, 'part1.flv'), 0),
      makeSegment(path.join(tempDir, 'part2.flv'), 1)
    ], outputPath);

    const args = runFfmpeg.mock.calls[0][0] as string[];
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args).not.toContain('-c:a');
    expect(args).not.toContain('aac');
    expect(fs.existsSync(path.join(tempDir, 'filelist.txt'))).toBe(false);
  });

  test('fills gaps while still preferring stream-copy merge', async () => {
    const merger = new FileMerger();
    const runFfmpeg = jest.spyOn(merger as any, 'runFfmpeg').mockResolvedValue(undefined);
    const createBlankVideo = jest
      .spyOn(merger, 'createBlankVideo')
      .mockResolvedValue(path.join(tempDir, 'blank_60000.flv'));
    const outputPath = path.join(tempDir, 'merged.flv');
    const first = makeSegment(path.join(tempDir, 'part1.flv'), 0);
    const second = makeSegment(path.join(tempDir, 'part2.flv'), 2);

    await merger.mergeVideos([first, second], outputPath);

    expect(createBlankVideo).toHaveBeenCalledWith(tempDir, 60000, first.videoPath);
    const args = runFfmpeg.mock.calls[0][0] as string[];
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args).not.toContain('-c:a');
  });

  test('creates blank video with reference media parameters', async () => {
    const merger = new FileMerger();
    const runFfmpeg = jest.spyOn(merger as any, 'runFfmpeg').mockResolvedValue(undefined);
    jest.spyOn(merger as any, 'getMediaProfile').mockResolvedValue({
      width: 1280,
      height: 720,
      frameRate: '30000/1001',
      audioSampleRate: '44100',
      audioChannelLayout: 'mono'
    });

    await merger.createBlankVideo(tempDir, 2000, path.join(tempDir, 'part1.flv'));

    const args = runFfmpeg.mock.calls[0][0] as string[];
    expect(args).toContain('color=c=black:s=1280x720:r=30000/1001:d=2');
    expect(args).toContain('anullsrc=r=44100:cl=mono');
    expect(args).toContain('-threads');
    expect(args[args.indexOf('-threads') + 1]).toBe('1');
  });
});
