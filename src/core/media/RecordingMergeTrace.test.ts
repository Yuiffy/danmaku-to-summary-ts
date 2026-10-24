import { findMergeTrace, measuredMergeSpans, matchPacketOffset } from './RecordingMergeTrace';

const name = '录制-1-20261024-190000-1-game_merged.flv';
const traceLog = `开始合并XML文件: 2 个片段\n处理片段: 录制-1-20261024-190000-1-game.xml, 偏移量: 100000ms\nXML偏移增加空白时间: 5000ms\n处理片段: later.xml, 偏移量: 205000ms\nXML合并完成: ${name.replace('.flv', '.xml')}`;

test('recovers actual merge order and measured offsets, rather than recording wall clocks', () => {
    const trace = findMergeTrace(traceLog, name)!;
    expect(measuredMergeSpans(trace, [100, 100], 205.12)).toEqual([
        { start: 0, duration: 100 }, { start: 105, duration: 100 }
    ]);
    expect(findMergeTrace(traceLog, 'other_merged.flv')).toBeNull();
});

test('incomplete, interleaved, repeated and changed-duration merge evidence fails closed', () => {
    expect(findMergeTrace(traceLog.replace('2 个片段', '3 个片段'), name)).toBeNull();
    expect(findMergeTrace(traceLog.replace('later.xml', '录制-1-20261024-190000-1-game.xml'), name)).toBeNull();
    expect(findMergeTrace(traceLog.replace('later.xml', 'another.xml\nXML合并完成: other.xml\n处理片段: later.xml'), name)).toBeNull();
    const trace = findMergeTrace(traceLog, name)!;
    expect(() => measuredMergeSpans(trace, [100, 100], 220)).toThrow('differs');
    expect(() => measuredMergeSpans(trace, [100, 110], 205)).toThrow('offset');
    expect(() => measuredMergeSpans(trace, [NaN, 100], 205)).toThrow('offset');
});

test('packet proof requires exact consecutive payloads, stable timestamps, and a unique match', () => {
    const source = [0, 1, 2].map(pts => ({ pts, hash: `packet-${pts}` }));
    const output = source.map(p => ({ ...p, pts: p.pts + 105.02 }));
    expect(matchPacketOffset(source, output, 105)).toBeCloseTo(105.02);
    expect(() => matchPacketOffset(source, output.map(p => ({ ...p, hash: 'different' })), 105)).toThrow('uniquely');
    expect(() => matchPacketOffset(source, [...output, ...output], 105)).toThrow('uniquely');
    expect(() => matchPacketOffset(source, output.map((p, i) => ({ ...p, pts: p.pts + i })), 105)).toThrow('uniquely');
    expect(() => matchPacketOffset(source, output, 110)).toThrow('uniquely');
    expect(() => matchPacketOffset(source.slice(0, 1), output, 105)).toThrow('incomplete');
});
