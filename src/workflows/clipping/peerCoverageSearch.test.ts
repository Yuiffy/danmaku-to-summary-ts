import { buildCoverageQueries, buildCoverageSearchPlan, coverageHostQuery } from './peerCoverageSearch';
import type { CoverageCandidate } from './peerCoverage';

const candidate: CoverageCandidate = { id: '1', roomId: '2', host: '小栞', title: '改写的事件标题', source: 'source.mp4',
    start: 0, end: 5, cues: [{ id: 'S1', start: 0, end: 4, text: '[UNKNOWN 0.75] [栞栞 0.9] 我顶多对着镜子拍拍泳装照' }] };
const registry = { host: { roomIds: ['2'], displayName: '栞栞', searchTags: ['栞栞', '栞栞Shiori'], aiClipName: '小栞' },
    guest: { roomIds: ['3'], displayName: '岁己', aiClipName: '小岁' } };

test('recording room and registered search tags select the public search name', () => {
    expect(coverageHostQuery(candidate, registry)).toBe('栞栞');
    expect(coverageHostQuery({ ...candidate, host: '小岁' }, registry)).toBe('栞栞');
    expect(coverageHostQuery({ ...candidate, roomId: '' }, registry)).toBe('栞栞');
    expect(coverageHostQuery({ roomId: 'unknown', host: '别的主播' }, registry)).toBe('别的主播');
});
test('recent pages reserve recall capacity even when model queries fill the keyword budget', () => {
    const plan = buildCoverageSearchPlan(candidate, ['模型词1', '模型词2', '模型词3', '模型词4'], 4, 5, registry);
    expect(plan).toEqual([
        { query: '栞栞', limit: 20, order: 'pubdate', page: 1 },
        { query: '栞栞', limit: 20, order: 'pubdate', page: 2 },
        { query: '模型词1', limit: 5 }, { query: '模型词2', limit: 5 }
    ]);
    expect(buildCoverageSearchPlan(candidate, [], 1, 5, registry)).toHaveLength(1);
});
test('targeted searches remove speaker labels without changing subtitle evidence', () => {
    expect(buildCoverageQueries(candidate, [], 4)).toContain('小栞 我顶多对着镜子拍拍泳装照');
    expect(candidate.cues[0].text).toContain('[UNKNOWN 0.75]');
});
