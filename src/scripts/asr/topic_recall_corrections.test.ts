export {};
const fs = require('fs');
const path = require('path');
const { resolveAsrHotwords } = require('./asr_backends');
const { applyCorrectionsToSegments } = require('./asr_corrections');
const production = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../config/production.json'), 'utf8'));
const corrections = (room: string) => resolveAsrHotwords(production, { room_id: room }).corrections;
const subset = (room: string) => ({ ambiguous: corrections(room).ambiguous.filter(rule => ['小碎', '赛吉斯'].includes(rule.from)) });

describe('production room-scoped subtitle normalization', () => {
    test.each([
        ['1791260716', '给小碎看送海獭', '给小岁看送海獭'],
        ['1791260716', '给小碎买海獭', '给小岁买海獭'],
        ['1791260716', '给小碎送海獭', '给小岁送海獭'],
        ['26966466', '一起支持赛吉斯', '一起支持岁己']
    ])('normalizes the corroborated recipient/name in room %s', (room, text, expected) => {
        expect(applyCorrectionsToSegments([{ text }], subset(room))[0]).toBe(expected);
    });
    test.each(['给小碎片画海獭图案', '海獭迈着小碎步', '给小碎石旁的海獭拍照',
        '海獭旁边的小碎花小碎块小碎屑小碎发小碎钻', '海獭玩具打小碎了',
        '给小碎机买海獭', '给海獭买一个小碎机玩具', '给小碎买礼物', '粉碎机工作了',
        '小case啦', '小睡一会'])('protects ordinary words and missing recipient context: %s', text => {
        expect(applyCorrectionsToSegments([{ text }], subset('1791260716'))[0]).toBe(text);
    });
    test.each([['给小碎', '片画海獭图案'], ['给小碎', '步跑来的海獭拍照'], ['海獭玩具', '打小碎', '了']])(
        'protects words split over subtitle cues: %j', (...texts: string[]) => {
            expect(applyCorrectionsToSegments(texts.map(text => ({ text })), subset('1791260716'))).toEqual(texts);
        });
    test('room additions compose with the global rule and do not change other-room behavior', () => {
        const global = corrections('123').ambiguous.find(rule => rule.from === '小碎');
        const combined = corrections('1791260716').ambiguous.filter(rule => rule.from === '小碎');
        expect(combined).toHaveLength(2);
        expect(combined).toContainEqual(global);
        expect(combined.find(rule => rule.require_nearby.includes('海獭'))).toMatchObject({
            require_nearby: ['海獭'], context_window_tokens: 6, boundary_sensitive: false
        });
        expect(global).toMatchObject({
            from: '小碎', to: '小岁', require_nearby: ['主播', '直播', '开播', 'SUI', '岁己', '饼干岁', 'VR', 'VirtuaReal'],
            context_window_tokens: 6, match_mode: 'token', boundary_sensitive: true, protect: undefined
        });
        for (const room of ['123', '1791260716']) {
            expect(applyCorrectionsToSegments([{ text: '岁己。小碎' }], subset(room))[0]).toBe('岁己。小岁');
            for (const text of ['岁己。小碎步', '岁己。小碎片', '岁己。打小碎了']) {
                expect(applyCorrectionsToSegments([{ text }], subset(room))[0]).toBe(text);
            }
            const texts = ['岁己。小碎', '步'];
            expect(applyCorrectionsToSegments(texts.map(text => ({ text })), subset(room))).toEqual(texts);
        }
        expect(applyCorrectionsToSegments([{ text: '给小碎看送海獭' }], subset('123'))[0]).toBe('给小碎看送海獭');
        expect(applyCorrectionsToSegments([{ text: '一起支持赛吉斯' }], subset('123'))[0]).toBe('一起支持赛吉斯');
        expect(applyCorrectionsToSegments([{ text: '支持马赛吉斯球队' }], subset('26966466'))[0]).toBe('支持马赛吉斯球队');
        for (const room of ['26966466', '1791260716', '1713548468', '1986461465']) {
            const rules = corrections(room);
            expect([...rules.safe, ...rules.contextual, ...rules.ambiguous]
                .some(rule => ['随机', '随即', '自己', '这一集', 'c机'].includes(rule.from))).toBe(false);
        }
    });
});
