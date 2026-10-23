'use strict';
const path = require('path');
const { sha, getActivityConfig } = require('./stream_activity_plan');
const VERSION = 2;
const WATCH_VERSION = 4;
const titleStage = () => require('../workflow-runtime').loadWorkflow('clipping/activityTitles');
const watchStage = () => require('../workflow-runtime').loadWorkflow('clipping/watchPublicNames');
const PROFILES = Object.freeze({
    songs: { prefix: '【岁己歌切】', label: '歌切', style: 'music_session', edition: 'LIVE MUSIC' },
    watch: { prefix: '【岁己同步视听】', label: '同步视听', style: 'cinema_session', edition: 'WATCH ALONG' }
});

function presentationFor(plan, kind, renderedParts, titleEvidence = null, baseTags = null) {
    const profile = PROFILES[kind];
    if (!profile) throw new Error(`Unknown activity presentation kind: ${kind}`);
    let events = plan.events.filter(event => event.kind === (kind === 'songs' ? 'song' : 'watch'));
    events = titleStage().namedEvents(events, titleEvidence);
    const publicNames = kind === 'watch' ? watchStage().watchPublicNames(events) : null;
    const publicEvents = kind === 'watch' ? events.map((event, i) => ({ ...event, name: publicNames[i].publicName })) : events;
    const songDate = kind === 'songs' ? titleStage().songDate(plan.recordedAt) : null;
    const recordingDate = songDate || titleStage().songDate(plan.recordedAt);
    const parts = (renderedParts || plan.parts[kind]).map((part, index, all) => {
        const event = publicEvents.find(row => row.id === part.activityId) || part;
        const group = all.filter(row => row.activityId === part.activityId);
        const title = kind === 'songs'
            ? titleStage().songTitle(event.name, songDate)
            : `《${event.name || '待确认片名'}》 ${String(group.indexOf(part) + 1).padStart(2, '0')}/${String(group.length).padStart(2, '0')}`;
        return { ...part, ...(kind === 'songs' ? { name: event.name || null } : {}), title: Array.from(title).slice(0, 80).join('') };
    });
    const subject = kind === 'songs'
        ? titleStage().songCoverSubject(events)
        : titleStage().watchCoverSubject(publicEvents);
    const time = String(plan.recordedAt || '').slice(11, 16);
    const streamTitle = kind === 'watch' ? watchStage().watchPublicText(plan.streamTitle, events) : plan.streamTitle;
    const lines = [`${plan.streamerName} ${plan.recordedAt} 直播《${streamTitle}》`,
        kind === 'songs' ? '按演唱顺序收录本场歌切，保留原始直播音画。' : '按本场观看顺序分 P，保留原始直播音画及观看过程中的反应和讨论。',
        ...parts.map((part, index) => `P${index + 1} ${part.title}${kind === 'songs' && part.performance === 'fragment' ? ' · 片段演唱' : ''}`)];
    while (lines.join('\n').length > 1900 && lines.length > 2) lines.pop();
    const maxTitleLength = 80 - Array.from(profile.prefix).length;
    const copy = { title: kind === 'songs' ? titleStage().songSubmissionTitle(events, songDate, maxTitleLength)
        : titleStage().watchSubmissionTitle(publicEvents, recordingDate, maxTitleLength),
        coverText: `${subject}\n${recordingDate}`, description: lines.join('\n') };
    const cover = { version: 2, kind, ...profile, subject, date: recordingDate, time,
        ...(kind === 'songs' ? { caption: parts.length > 1 ? `直播演唱 · 共 ${parts.length} 首`
            : events[0]?.performance === 'fragment' ? '片段演唱' : '直播演唱' } : {}),
        streamerName: plan.streamerName, parts: parts.length };
    const tags = kind === 'songs' ? titleStage().songSubmissionTags(parts, baseTags || getActivityConfig().songs.tags)
        : watchStage().WATCH_PUBLIC_TAGS;
    const signature = sha({ cover, copy, ...(kind === 'songs' ? { tags } : {}), ...(publicNames ? { publicNames } : {}), ...(titleEvidence ? { titleEvidence } : {}),
        parts: parts.map(part => ({ sha256: part.sha256, title: part.title })) });
    return { version: kind === 'watch' ? WATCH_VERSION : VERSION, signature, profile, copy, cover, parts, recordingDate, tags,
        ...(publicNames ? { publicNames } : {}) };
}
function coverPathFor(metadataPath, presentation) {
    return path.join(path.dirname(metadataPath), `${presentation.cover.kind}.cover-v${presentation.version}-${presentation.signature.slice(0, 12)}.jpg`);
}
module.exports = { VERSION, PROFILES, presentationFor, coverPathFor };
