import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../../core/config/ProjectPaths';
import { deferredSelectionRows } from '../../workflows/clipping/reviewSelectionHistory';
import { campaignCandidateId, campaignCandidateMetadata, campaignCandidatePath, candidateDigest } from '../../workflows/clipping/campaignCandidate';

/** Prepare one persisted selection for the existing locked import-json CLI; never queue or approve. */
export function prepareCampaignCandidate(input: { state: string; id: string; selectionDigest: string; sourceDigest: string }, root = getProjectRoot()): string {
  const state = JSON.parse(fs.readFileSync(input.state, 'utf8').replace(/^\uFEFF/u, ''));
  if (state.type !== 'own_stream_review_state') throw new Error('Invalid review state');
  const context = state.metadata || {};
  const row = deferredSelectionRows(context).find(row => row.sourceMediaPath && row.sourceSrtPath && campaignCandidateId(row) === input.id);
  if (!row || candidateDigest(JSON.stringify(row)) !== input.selectionDigest) throw new Error('候选已变化，请刷新后重试');
  const source = fs.readFileSync(row.sourceSrtPath, 'utf8').replace(/^\uFEFF/u, '');
  if (candidateDigest(source) !== input.sourceDigest) throw new Error('原片字幕已变化，请刷新后重试');
  if (!fs.statSync(row.sourceMediaPath).size) throw new Error('原片不存在或为空');
  const destination = campaignCandidatePath(row.sourceMediaPath, input.id);
  if (fs.existsSync(destination)) {
    const saved = JSON.parse(fs.readFileSync(destination, 'utf8'));
    if (saved.campaignCandidate?.id !== input.id || saved.campaignCandidate?.selectionKey !== row.selectionKey) throw new Error('Existing candidate identity does not match');
    return destination; // An interrupted registration never overwrites an existing revision.
  }
  const topic = require(path.join(root, 'src/scripts/topic_clipper.js'));
  const { buildSubtitleEvidence } = require(path.join(root, 'src/scripts/clipping/subtitle_evidence.js'));
  const { buildOwnUploadSettings } = require(path.join(root, 'src/scripts/clipping/own_upload_registry.js'));
  const parsed = topic.parseTopicSrt(row.sourceSrtPath), evidence = buildSubtitleEvidence(parsed.segments);
  const campaignCopy = String(context.roomId) === '25788785' ? {}
    : { tags: [context.streamerName, '芙娅之魂', '虚拟主播', '直播切片', 'AI切片'].filter(Boolean) };
  const upload = buildOwnUploadSettings(context, { ...campaignCopy, ...row.candidate?.copy });
  if (context.uploadManifestPath && fs.existsSync(context.uploadManifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(context.uploadManifestPath, 'utf8').replace(/^\uFEFF/u, ''));
    if (String(manifest.roomId || manifest.upload?.roomId) !== String(context.roomId)) throw new Error('原投稿清单的主播身份不匹配');
    for (const key of ['source', 'prefix', 'tags', 'tid']) if (manifest.upload?.[key] !== undefined) upload[key] = manifest.upload[key];
  }
  const metadata = campaignCandidateMetadata(row, context, evidence, upload);
  metadata.preRenderSource = require(path.join(root, 'src/scripts/clipping/source_snapshot.js')).sourceSnapshot(metadata);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  topic.writeClipSrt(parsed.segments, metadata.window, metadata.output.srtPath);
  fs.writeFileSync(destination, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return destination;
}

if (require.main === module) {
  try {
    const options = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((rows, value, index, args) => index % 2 ? rows : [...rows, [value.replace(/^--/u, ''), args[index + 1]]], []));
    const metadataPath = prepareCampaignCandidate({ state: options.state, id: options.id, selectionDigest: options['selection-digest'], sourceDigest: options['source-digest'] });
    console.log(`CAMPAIGN_CANDIDATE_RESULT: ${JSON.stringify({ metadataPath })}`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
