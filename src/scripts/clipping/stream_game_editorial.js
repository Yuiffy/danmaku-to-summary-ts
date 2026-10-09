'use strict';
const fs = require('fs');
const path = require('path');
const asr = require('../asr/asr_backends');
const { fileDigest } = require('./source_snapshot');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { sha, chapterPhaseEnd, evidenceRows } = require('./stream_game_plan');
const { withSelectionCache } = require('./selection_cache');
const { requestMediaVerification } = require('./stream_activity_verification');
const editorialStage = () => require('../workflow-runtime').loadWorkflow('clipping/gameEditorial');
function parseCopyProposal(response, chapter) {
    const row = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
    if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > (chapter.nameEvidenceSource === 'original_frame' ? 60 : 24)
        || typeof row.description !== 'string' || !row.description.trim() || row.description.length > 48
        || !String(row.reason || '').trim()) throw new Error('Invalid factual game chapter copy proposal');
    const normalize = value => String(value || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    if (chapter.nameEvidenceSource === 'original_frame' && row.title !== chapter.title
        || chapter.kind !== 'phase' && chapter.nameEvidence && !normalize(row.title).includes(normalize(chapter.nameEvidence))) {
        throw new Error('Game copy repair cannot discard a verified name');
    }
    return row;
}
/** Draft factual replacement copy; only the subsequent complete media review may approve it. */
async function repairUnsupportedChapters(event, plan, verification, options, files, settings) {
    const unsupported = (verification.chapterReviews || []).filter(c => c.supported === false);
    const cues = asr.parseSrt(options.srtPath).segments;
    const sourceRows = evidenceRows(cues);
    let changed = false;
    for (const rejection of unsupported) {
        const index = rejection.index - 1, chapter = event.chapters[index];
        if (!chapter || !editorialStage().canRepairChapter(chapter)) continue;
        const end = chapterPhaseEnd(event, index);
        const phaseFrames = (verification.originalFrameEvidence || []).filter(f => f.time >= chapter.start && f.time < end);
        if (!phaseFrames.length) continue;
        const frames = [...new Map([phaseFrames[0], phaseFrames[Math.floor(phaseFrames.length / 2)], phaseFrames.at(-1)]
            .map(f => [f.time, f])).values()];
        if (chapter.frameNameEvidence) {
            const selected = chapter.frameNameEvidence.frames.find(f => f.index === chapter.frameNameEvidence.selectedFrameIndex);
            const named = phaseFrames.find(f => f.time === selected?.time);
            if (named && !frames.some(f => f.time === named.time)) frames[frames.length-1] = named;
        }
        for (const frame of frames) if (fileDigest(frame.path) !== frame.sha256) throw new Error('Original game editorial frame changed');
        const phaseRows = sourceRows.filter(c => c.end > chapter.start && c.start < end);
        const transcript = phaseRows.map(c => ({id:c.id,start:c.start,end:c.end,text:c.text}));
        const directory = path.join(files.directory, 'temp', 'game-editorial-repairs', sha({ version: editorialStage().GAME_COPY_POLICY_VERSION, source: plan.source, chapter,
            end, rejection, frames, settings }).slice(0,16)); fs.mkdirSync(directory,{recursive:true});
        const prompt = editorialStage().chapterCopyPrompt(chapter, rejection, end, frames, transcript);
        const response = await withSelectionCache({ directory:path.join(files.directory,'temp','game-editorial-cache'),phase:'game-copy-proposal-v1',
            prompt,signature:{source:plan.source,settings,frames},validate:value=>{try{parseCopyProposal(value,chapter);return true;}catch{return false;}} },
        ()=>(options.editorialRequest||options.verifyRequest||requestMediaVerification)(prompt,frames.map(f=>({...f,mimeType:'image/jpeg'})),options.config,settings));
        const row = parseCopyProposal(response, chapter);
        if (row.title===chapter.title&&row.description===chapter.description
            && JSON.stringify(chapter.evidenceIds)===JSON.stringify(phaseRows.map(c=>c.id))) continue;
        const proposalPath=path.join(directory,'PROPOSAL.json');writeJsonAtomic(proposalPath,response);
        event.chapters[index] = { ...chapter,title:row.title,description:row.description,
            evidenceIds: phaseRows.map(c => c.id), editorialRevision:{version:1,policyVersion:editorialStage().GAME_COPY_POLICY_VERSION,source:plan.source,
            ...(chapter.editorialRevision ? {previousRevision:chapter.editorialRevision} : {}),
            originalCopy:{title:chapter.title,description:chapter.description},newCopy:{title:row.title,description:row.description},
            originalEvidenceIds:chapter.evidenceIds, rejectionReason:rejection.reason,phaseStart:chapter.start,phaseEnd:end,frames,proposalPath,proposalSha256:fileDigest(proposalPath)} };
        changed=true;
    }
    return changed;
}
module.exports = { parseCopyProposal, repairUnsupportedChapters };
