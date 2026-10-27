/** Local screenshot-video policy. Social posts never imply livestream speech. */
export interface SocialPostPlan {
    version: 1;
    source: { image: string; url: string; captureUrl: string; author: string; publishedAt: string; text: string; captureLabel: string;
        comments?: { author: string; text: string; publishedAt: string }[];
        pages?: { image: string; label: string; comments: { author: string; text: string; publishedAt: string }[] }[] };
    copy: { title: string; description: string; tags: string[] };
    scenes: { seconds: number; heading: string; visibleHeight?: number; page?: number }[];
    music?: { path: string; credit: string; gainDb?: number };
}
export interface ImageSize { width: number; height: number }
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export function validateSocialPost(plan: SocialPostPlan, image: ImageSize) {
    if (plan.version !== 1 || !plan.source || !plan.copy) throw new Error('Expected a version 1 social-post plan');
    for (const key of ['image', 'author', 'publishedAt', 'text', 'captureLabel'] as const) {
        if (!nonempty(plan.source[key])) throw new Error(`Missing source.${key}`);
    }
    for (const key of ['url', 'captureUrl'] as const) {
        const u = new URL(plan.source[key]);
        if (u.protocol !== 'https:' || u.username || u.password) throw new Error(`source.${key} must be a public HTTPS URL`);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(plan.source.publishedAt)
        || !Number.isFinite(Date.parse(plan.source.publishedAt))) throw new Error('publishedAt needs an ISO date with timezone');
    if (!nonempty(plan.copy.title) || !nonempty(plan.copy.description)
        || !Array.isArray(plan.copy.tags) || !plan.copy.tags.length || !plan.copy.tags.every(nonempty)) throw new Error('Complete public copy is required');
    if (plan.source.comments && (!Array.isArray(plan.source.comments) || plan.source.comments.length > 10
        || plan.source.comments.some(c => !nonempty(c.author) || !nonempty(c.text) || !nonempty(c.publishedAt)))) throw new Error('Comment evidence needs its own author, text and date');
    if (plan.source.pages && (!Array.isArray(plan.source.pages) || plan.source.pages.length > 30 || plan.source.pages.some(p =>
        !nonempty(p.image) || !nonempty(p.label) || !Array.isArray(p.comments) || !p.comments.length || p.comments.length > 10
        || p.comments.some(c => !nonempty(c.author) || !nonempty(c.text) || !nonempty(c.publishedAt))))) throw new Error('Comment pages need images, labels and individually attributed comment evidence');
    if (!Array.isArray(plan.scenes) || !plan.scenes.length || plan.scenes.length > 32) throw new Error('Use 1–32 scenes');
    let duration = 0;
    for (const scene of plan.scenes) {
        if (!Number.isFinite(scene.seconds) || scene.seconds < 2 || scene.seconds > 60) throw new Error('Scene duration must be 2–60 seconds');
        if (!nonempty(scene.heading) || Array.from(scene.heading).length > 24) throw new Error('Scene heading must contain 1–24 characters');
        if (scene.page !== undefined && (!Number.isInteger(scene.page) || scene.page < 0 || scene.page > (plan.source.pages?.length ?? 0))) throw new Error('Unknown screenshot page');
        if (scene.page && scene.visibleHeight !== undefined) throw new Error('Comment pages must be shown complete');
        if (scene.visibleHeight !== undefined && (!Number.isInteger(scene.visibleHeight) || scene.visibleHeight < 1 || scene.visibleHeight > image.height)) throw new Error('Reveal boundary is outside the screenshot');
        duration += scene.seconds;
    }
    if (duration > 180) throw new Error('Screenshot video is limited to 180 seconds');
    if (!plan.scenes.some(s => !s.page && (s.visibleHeight === undefined || s.visibleHeight === image.height))) throw new Error('At least one scene must show the complete original screenshot');
    const last = plan.scenes[plan.scenes.length - 1];
    if (last.visibleHeight !== undefined && last.visibleHeight !== image.height) throw new Error('The final scene must show the complete screenshot');
    if (plan.music && (!nonempty(plan.music.path) || !nonempty(plan.music.credit)
        || !Number.isFinite(plan.music.gainDb ?? -12) || (plan.music.gainDb ?? -12) > 0 || (plan.music.gainDb ?? -12) < -60)) throw new Error('Music needs a local path, credit and gain between -60 and 0 dB');
    return { duration, canvas: { width: 1920, height: 1080 }, ...fitSocialPostImage(image) };
}
export function fitSocialPostImage(image: ImageSize) {
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 100 || image.height < 50) throw new Error('Invalid source screenshot dimensions');
    // Fit the complete screenshot: no cropping or distortion, including tall posts.
    const scale = Math.min(1520 / image.width, 650 / image.height);
    const width = Math.floor(image.width * scale), height = Math.floor(image.height * scale);
    if (width < 420) throw new Error('Screenshot is too tall; split it into readable source images first');
    return { card: { x: Math.floor((1920 - width) / 2), y: Math.floor(590 - height / 2), width, height },
        readingScale: scale };
}
export const escapeSvg = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function socialPostDescription(plan: SocialPostPlan): string {
    return `${plan.copy.description.trim()}\n\n来源：${plan.source.author} 微博\n发布于：${plan.source.publishedAt}\n原帖：${plan.source.url}\n截图：${plan.source.captureLabel}\n展示页：${plan.source.captureUrl}`
        + (plan.music ? `\n配乐：${plan.music.credit}` : '');
}
