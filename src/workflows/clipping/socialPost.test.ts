import { SocialPostPlan, validateSocialPost, socialPostDescription, escapeSvg } from './socialPost';

const plan = (): SocialPostPlan => ({ version: 1,
    source: { image: 'post.png', author: '作者', publishedAt: '2026-08-28T14:24:00+08:00', text: '原文',
        url: 'https://weibo.com/detail/123', captureUrl: 'https://weibo.com/detail/123', captureLabel: '微博原帖截图' },
    copy: { title: '标题', description: '内容', tags: ['微博'] },
    scenes: [{ seconds: 7, heading: '问题', visibleHeight: 200 }, { seconds: 11, heading: '答案' }] });

test('fits the complete post without clipping and keeps the source-card position stable across reveals', () => {
    const result = validateSocialPost(plan(), { width: 1200, height: 500 });
    expect(result.duration).toBe(18);
    expect(result.card.width / result.card.height).toBeCloseTo(2.4, 2);
    expect(result.card.x).toBeGreaterThan(0);
    expect(result.card.y + result.card.height).toBeLessThan(960);
});
test('rejects a final reveal that hides part of the original post', () => {
    const p = plan(); p.scenes[1].visibleHeight = 499;
    expect(() => validateSocialPost(p, { width: 1200, height: 500 })).toThrow(/complete.*screenshot/);
});
test('comment pages have their own evidence and may follow a complete original post', () => {
    const p = plan(); p.source.pages = [{ image: 'comments.png', label: '评论截图', comments: [{ author: '观众', text: '评论', publishedAt: '2026-08-28' }] }];
    p.scenes.push({ seconds: 5, heading: '评论区', page: 1 });
    expect(validateSocialPost(p, { width: 1200, height: 500 }).duration).toBe(23);
    p.scenes[2].page = 2;
    expect(() => validateSocialPost(p, { width: 1200, height: 500 })).toThrow('Unknown screenshot');
});
test.each([NaN, -1, 61, Infinity])('rejects invalid scene duration %s', seconds => {
    const p = plan(); p.scenes[0].seconds = seconds;
    expect(() => validateSocialPost(p, { width: 1200, height: 500 })).toThrow('duration');
});
test('rejects unreadably tall screenshots and out-of-image reveals', () => {
    expect(() => validateSocialPost(plan(), { width: 500, height: 3000 })).toThrow('too tall');
    const p = plan(); p.scenes[0].visibleHeight = 501;
    expect(() => validateSocialPost(p, { width: 1200, height: 500 })).toThrow('boundary');
});
test('requires timezone and music provenance rather than inferring a recording date or creator', () => {
    const p = plan(); p.source.publishedAt = '2026-08-28';
    expect(() => validateSocialPost(p, { width: 1200, height: 500 })).toThrow('timezone');
    p.source.publishedAt = plan().source.publishedAt; p.music = { path: 'music.wav', credit: '' };
    expect(() => validateSocialPost(p, { width: 1200, height: 500 })).toThrow('Music');
});
test('public copy accurately credits a post and capture page without inventing live timestamps', () => {
    const description = socialPostDescription(plan());
    expect(description).toContain('作者 微博');
    expect(description).toContain('2026-08-28T14:24:00+08:00');
    expect(description).not.toMatch(/直播开始|切片时间/);
    expect(escapeSvg('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;');
});
