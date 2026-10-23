export interface CampaignTrigger {
    id: string; enabled: boolean; roomIds: string[]; startsAt: string; endsAt: string;
    earlyTrigger?: { enabled: boolean; titleKeywords: string[]; activatedAt: string };
}
export interface RecordingCandidate {
    videoPath: string; xmlPath: string; roomId: string; day: string; title: string;
    startedAt: number; modifiedAt: number; size: number; xmlExists: boolean;
}
export interface EarlyBatch { campaignId: string; roomId: string; day: string; sources: RecordingCandidate[]; transitionAt: number }

export function parseCampaignRecording(videoPath: string, filename: string): Pick<RecordingCandidate, 'videoPath' | 'roomId' | 'day' | 'title' | 'startedAt'> | null {
    const match = filename.match(/^录制-(\d+)-(\d{8})-(\d{6})-\d+-(.+)\.flv$/u);
    if (!match || /_merged$/u.test(match[4])) return null;
    const [, roomId, day, clock, title] = match;
    const startedAt = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6)}+08:00`);
    return Number.isFinite(startedAt) ? { videoPath, roomId, day, title, startedAt } : null;
}

/** A later, different-title recording is closure evidence; mtime alone is insufficient. */
export function selectEarlyBatches(campaigns: CampaignTrigger[], recordings: RecordingCandidate[], now: number,
    manualRoom?: string): EarlyBatch[] {
    const batches: EarlyBatch[] = [];
    for (const campaign of campaigns) {
        const trigger = campaign.earlyTrigger;
        if (!campaign.enabled || !trigger?.enabled || now < Date.parse(campaign.startsAt) || now >= Date.parse(campaign.endsAt)) continue;
        for (const roomId of campaign.roomIds.map(String).filter(room => !manualRoom || room === manualRoom)) {
            const rows = recordings.filter(row => row.roomId === roomId).sort((a, b) => a.startedAt - b.startedAt);
            let sources: RecordingCandidate[] = [];
            for (const row of rows) {
                const matches = trigger.titleKeywords.some(keyword => keyword.trim() && row.title.includes(keyword));
                const eligible = row.startedAt >= Date.parse(campaign.startsAt) && row.startedAt < Date.parse(campaign.endsAt);
                if (matches && eligible) { sources.push(row); continue; }
                if (sources.length && sources.every(source => source.xmlExists && source.size > 0 && now - source.modifiedAt >= 90000)
                    && (manualRoom || row.startedAt >= Date.parse(trigger.activatedAt))) {
                    batches.push({ campaignId: campaign.id, roomId, day: sources[0].day, sources, transitionAt: row.startedAt });
                }
                sources = [];
            }
        }
    }
    return batches;
}
