'use strict';
const path = require('path');
const { sha } = require('./stream_activity_plan');
const VERSION = 1;
const PROFILES = Object.freeze({
    songs: { prefix: '【岁己歌切】', label: '歌切', style: 'music_session', edition: 'LIVE MUSIC' },
    watch: { prefix: '【岁己同步视听】', label: '同步视听', style: 'cinema_session', edition: 'WATCH ALONG' }
});

function watchingLabel(event = {}) {
    return event.mediaKind === 'movie' ? '电影同看' : event.mediaKind === 'series' ? '剧集同看' : '本场同看';
}
function presentationFor(plan, kind, renderedParts, titleEvidence = null) {
    const profile = PROFILES[kind];
    if (!profile) throw new Error(`Unknown activity presentation kind: ${kind}`);
    let events = plan.events.filter(event => event.kind === (kind === 'songs' ? 'song' : 'watch'));
    if (titleEvidence) {
        if (events.length !== 1 || titleEvidence.activityId !== events[0].id) throw new Error('A reviewed content name must refer to one specific source activity');
        events = events.map(event => ({ ...event, name: titleEvidence.name }));
    }
    const parts = (renderedParts || plan.parts[kind]).map((part, index, all) => {
        const event = events.find(row => row.id === part.activityId) || part;
        const group = all.filter(row => row.activityId === part.activityId);
        const number = String(index + 1).padStart(2, '0');
        const title = kind === 'songs'
            ? `${event.name ? `《${event.name}》` : `演唱 ${number}`}${event.performance === 'fragment' ? ' · 片段' : ''}`
            : `${event.name ? `《${event.name}》` : watchingLabel(event)} ${String(group.indexOf(part) + 1).padStart(2, '0')}/${String(group.length).padStart(2, '0')}`;
        return { ...part, title: Array.from(title).slice(0, 80).join('') };
    });
    const names = [...new Set(events.map(event => event.name).filter(Boolean))];
    const subject = kind === 'songs'
        ? (events.length === 1 ? (names[0] ? `《${names[0]}》${events[0].performance === 'fragment' ? ' · 片段' : ''}`
            : events[0].performance === 'fragment' ? '片段演唱' : '本场演唱') : '本场演唱合集')
        : names.length === 1 ? `《${names[0]}》` : names.length > 1 ? '本场同看合集' : watchingLabel(events[0]);
    const date = String(plan.recordedAt || '').slice(0, 10);
    const time = String(plan.recordedAt || '').slice(11, 16);
    const session = `${date}${/^\d{2}:\d{2}$/u.test(time) ? ` ${time}` : ''}`;
    const lines = [`${plan.streamerName} ${plan.recordedAt} 直播《${plan.streamTitle}》`,
        kind === 'songs' ? '按演唱顺序收录本场歌切，保留原始直播音画。' : '按本场观看顺序分 P，保留原始直播音画及观看过程中的反应和讨论。',
        ...parts.map((part, index) => `P${index + 1} ${part.title}`)];
    while (lines.join('\n').length > 1900 && lines.length > 2) lines.pop();
    const maxTitleLength = 80 - Array.from(profile.prefix).length;
    const copy = { title: Array.from(`${session}｜${subject}`).slice(0, maxTitleLength).join(''),
        coverText: `${profile.label}\n${subject}\n${date.replace(/-/gu, '.')}`, description: lines.join('\n') };
    const cover = { version: VERSION, kind, ...profile, subject, date: date.replace(/-/gu, '.'), time,
        streamerName: plan.streamerName, parts: parts.length };
    const signature = sha({ cover, copy, ...(titleEvidence ? { titleEvidence } : {}),
        parts: parts.map(part => ({ sha256: part.sha256, title: part.title })) });
    return { version: VERSION, signature, profile, copy, cover, parts };
}
function coverPathFor(metadataPath, presentation) {
    return path.join(path.dirname(metadataPath), `${presentation.cover.kind}.cover-v${VERSION}-${presentation.signature.slice(0, 12)}.jpg`);
}
module.exports = { VERSION, PROFILES, presentationFor, coverPathFor };
