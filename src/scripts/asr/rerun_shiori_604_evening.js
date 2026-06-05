#!/usr/bin/env node
/**
 * 重跑栞栞 6/4 晚场联动（with 岁己）的 ASR + diarization
 * 使用 paraformer backend + V3 speaker references
 */

const fs = require('fs');
const path = require('path');
const configLoader = require('../config-loader');
const asrBackends = require('./asr_backends');

const MEDIA_PATH = 'D:\\files\\videos\\DDTV录播\\26966466_栞栞Shiori\\2026_06_04\\录制-26966466-20260604-201307-648-海獭大战小鸟！_merged.m4a';
const OUTPUT_DIR = path.join(process.cwd(), 'tmp', 'shiori_604_rerun');
const SPEAKER_REF_DIR = 'D:\\files\\videos\\DDTV录播\\_speaker_references';

async function main() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    if (!fs.existsSync(MEDIA_PATH)) {
        console.error(`Media file not found: ${MEDIA_PATH}`);
        process.exit(1);
    }

    console.log('Loading config...');
    const config = configLoader.getConfig();

    // Build speaker references from V3 centroid refs
    // Use recent days for better quality
    const shioriRefs = [
        { speaker: '栞栞', audio_path: path.join(SPEAKER_REF_DIR, '栞栞Shiori', '2026_06_04_ref.wav'), chunk_s: 8, max_chunks: 20 },
        { speaker: '栞栞', audio_path: path.join(SPEAKER_REF_DIR, '栞栞Shiori', '2026_06_03_ref.wav'), chunk_s: 8, max_chunks: 20 },
        { speaker: '栞栞', audio_path: path.join(SPEAKER_REF_DIR, '栞栞Shiori', '2026_06_02_ref.wav'), chunk_s: 8, max_chunks: 20 },
    ];
    const suiRefs = [
        { speaker: '岁己SUI', audio_path: path.join(SPEAKER_REF_DIR, '岁己SUI', '2026_06_02_ref.wav'), chunk_s: 8, max_chunks: 20 },
        { speaker: '岁己SUI', audio_path: path.join(SPEAKER_REF_DIR, '岁己SUI', '2026_06_01_ref.wav'), chunk_s: 8, max_chunks: 20 },
        { speaker: '岁己SUI', audio_path: path.join(SPEAKER_REF_DIR, '岁己SUI', '2026_05_27_ref.wav'), chunk_s: 8, max_chunks: 20 },
    ];

    // Override config with V3 speaker refs for paraformer
    const runConfig = {
        ...config,
        asr: {
            ...config.asr,
            paraformer: {
                ...config.asr.paraformer,
                speaker_references: [...shioriRefs, ...suiRefs],
                speaker_reference_threshold: 0.45,
                speaker_reference_margin: 0.06,
                enable_speaker: true,
            }
        }
    };

    // Resolve hotwords for the room
    const runtime = asrBackends.resolveAsrHotwords(config, { room_id: '26966466' });

    console.log('Starting paraformer ASR with V3 speaker refs...');
    console.log(`  Media: ${MEDIA_PATH}`);
    console.log(`  Speaker refs: 栞栞 x${shioriRefs.length}, 岁己SUI x${suiRefs.length}`);
    console.log(`  Hotwords: ${(runtime.hotwords || []).join(', ')}`);

    const t0 = Date.now();
    const rawResult = await asrBackends.transcribeParaformer(MEDIA_PATH, runConfig, runtime);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`\nASR completed in ${elapsed}s`);
    console.log(`  Segments: ${rawResult.segments?.length || 0}`);

    // The raw result from transcribeParaformer already has segments with speaker labels
    const segments = rawResult.segments || [];
    console.log(`\nRaw segment count: ${segments.length}`);
    console.log(`Backend: ${rawResult.backend}`);
    if (segments.length > 0) {
        console.log(`First segment keys: ${Object.keys(segments[0]).join(', ')}`);
        console.log(`First 3 speakers: ${segments.slice(0, 3).map(s => s.speaker).join(', ')}`);
    }

    // Count speakers from raw result
    const speakerCounts = {};
    segments.forEach(seg => {
        const label = seg.speaker || 'UNKNOWN';
        speakerCounts[label] = (speakerCounts[label] || 0) + 1;
    });
    console.log('\nSpeaker distribution:');
    Object.entries(speakerCounts).sort((a, b) => b[1] - a[1]).forEach(([label, count]) => {
        const totalSpeech = segments
            .filter(s => (s.speaker || 'UNKNOWN') === label)
            .reduce((sum, s) => sum + (s.end - s.start), 0);
        console.log(`  ${label}: ${count} segments, ${totalSpeech.toFixed(0)}s`);
    });

    // Write outputs
    const baseName = path.parse(MEDIA_PATH).name;

    // Write raw result for debugging
    const rawPath = path.join(OUTPUT_DIR, `${baseName}.raw.json`);
    fs.writeFileSync(rawPath, JSON.stringify(rawResult, null, 2), 'utf-8');
    console.log(`\nRaw JSON: ${rawPath}`);

    // Write SRT from raw segments
    const srtPath = path.join(OUTPUT_DIR, `${baseName}.srt`);
    const srtLines = [];
    let idx = 1;
    segments.forEach(seg => {
        const text = String(seg.text || '').trim();
        if (!text) return;
        srtLines.push(String(idx));
        srtLines.push(`${fmtTime(seg.start)} --> ${fmtTime(seg.end)}`);
        srtLines.push(text);
        srtLines.push('');
        idx++;
    });
    fs.writeFileSync(srtPath, srtLines.join('\n'), 'utf-8');
    console.log(`SRT: ${srtPath}`);

    // Write speaker SRT
    const speakerSrtPath = path.join(OUTPUT_DIR, `${baseName}.speaker.srt`);
    const spSrtLines = [];
    idx = 1;
    segments.forEach(seg => {
        const text = String(seg.text || '').trim();
        if (!text) return;
        const speaker = seg.speaker || 'UNKNOWN';
        spSrtLines.push(String(idx));
        spSrtLines.push(`${fmtTime(seg.start)} --> ${fmtTime(seg.end)}`);
        spSrtLines.push(`[${speaker}] ${text}`);
        spSrtLines.push('');
        idx++;
    });
    fs.writeFileSync(speakerSrtPath, spSrtLines.join('\n'), 'utf-8');
    console.log(`Speaker SRT: ${speakerSrtPath}`);

    console.log('\n✅ Done!');

    function fmtTime(s) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = (s % 60).toFixed(3);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.padStart(6, '0').replace('.', ',')}`;
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
