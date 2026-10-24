export interface MergeTracePart { name: string; end: number }
export interface MergeTrace { parts: MergeTracePart[]; evidence: string }
export interface RecordingPacket { pts: number; hash: string }

/** Legacy XML merge progress records measured media offsets, including inserted gaps. */
export function findMergeTrace(log: string, outputName: string): MergeTrace | null {
    const lines = log.replace(/\u001b\[[0-9;]*m/gu, '').split(/\r?\n/u);
    for (let end = lines.length - 1; end >= 0; end--) {
        if (!lines[end].includes(`XML合并完成: ${outputName.replace(/\.flv$/u, '.xml')}`)) continue;
        const parts: MergeTracePart[] = [];
        for (let start = end - 1; start >= 0; start--) {
            if (lines[start].includes('XML合并完成:')) break;
            const part = /处理片段: (.+)\.xml, 偏移量: (\d+)ms/u.exec(lines[start]);
            if (part) parts.unshift({ name: `${part[1]}.flv`, end: Number(part[2]) / 1000 });
            const count = /开始合并XML文件: (\d+) 个片段/u.exec(lines[start]);
            if (!count) continue;
            if (parts.length !== Number(count[1]) || !parts.length
                || parts[0].name !== outputName.replace(/_merged\.flv$/u, '.flv')
                || new Set(parts.map(p => p.name)).size !== parts.length
                || parts.some((p, i) => p.end <= (parts[i - 1]?.end || 0))) break;
            return { parts, evidence: lines.slice(start, end + 1).filter(line =>
                /开始合并XML文件:|处理片段:|XML合并完成:/u.test(line)).join('\n') };
        }
    }
    return null;
}

export function measuredMergeSpans(trace: MergeTrace, durations: number[], outputDuration: number): { start: number; duration: number }[] {
    if (durations.length !== trace.parts.length || !durations.length || !Number.isFinite(outputDuration)
        || Math.abs(trace.parts.at(-1)!.end - outputDuration) > 2) throw new Error('Merge trace duration differs from current media');
    return durations.map((duration, index) => {
        const start = trace.parts[index].end - duration;
        const gap = start - (trace.parts[index - 1]?.end || 0);
        if (!(duration > 0 && Number.isFinite(duration)) || gap < -.002 || gap > 3600
            || index === 0 && Math.abs(start) > .002) throw new Error('Merge trace has an invalid source offset');
        return { start: Math.max(0, start), duration };
    });
}

/** Require a unique consecutive payload match and a consistent measured PTS translation. */
export function matchPacketOffset(source: RecordingPacket[], output: RecordingPacket[], expected: number): number {
    if (source.length < 3) throw new Error('Recording packet evidence is incomplete');
    const matches: number[] = [];
    for (let index = 0; index <= output.length - source.length; index++) {
        const offset = output[index].pts - source[0].pts;
        if (Math.abs(offset - expected) > .25) continue;
        if (source.every((packet, i) => packet.hash === output[index + i].hash
            && Math.abs(output[index + i].pts - packet.pts - offset) <= .002)) matches.push(offset);
    }
    if (matches.length !== 1) throw new Error('Merged recording packets do not uniquely match the source timeline');
    return matches[0];
}
