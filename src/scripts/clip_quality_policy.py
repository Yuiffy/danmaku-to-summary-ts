"""Publication-only quality checks. Decisions use injected readers and do not grant authority."""
import ntpath
try:
    from .clip_publication_duplicates import _purpose
except ImportError:
    from clip_publication_duplicates import _purpose


def quality_errors(clips, config, read_metadata, file_digest, validate_manual_review=None):
    policy = config.get('clipCuration') or {}
    if policy.get('enabled') is not True:
        return []
    errors = []
    for clip in clips:
        try:
            metadata = read_metadata(clip.get('metadataPath')) if clip.get('metadataPath') else {}
        except (OSError, ValueError, TypeError):
            metadata = {}
        if _purpose(clip, metadata) != ('ordinary',):
            continue
        if (metadata.get('mode') == 'manual_clip_queue' and not metadata.get('publicationKind')
                and not metadata.get('curation') and not metadata.get('automaticPublicationRequired')):
            continue  # Dedicated explicit manual queue retains its own approval contract.
        topic = (clip.get('publicationKind') or metadata.get('publicationKind')) in ('keyword_topic', 'keyword_topic_bundle')
        room = str(metadata.get('roomId') or clip.get('roomId') or '')
        if not (topic and policy.get('includeKeywordTopics') is True or room in policy.get('roomIds', [])
                or clip.get('prefix') == '【小岁】'):
            continue
        label = f"ID{clip.get('id', clip.get('idx', '?'))}"
        try:
            # A Web/CLI operator may choose the current ordinary or deferred
            # artifact. Only its existing content-bound review supplies authority;
            # a boolean flag or old approval must never release automatic stock.
            if (metadata.get('ownStreamHumanReview') or metadata.get('precisionPublicationReview') or metadata.get('bundlePublicationReview')) and validate_manual_review:
                validate_manual_review(clip, metadata)
                continue
            creative, qa, audio = (metadata.get(key) or {} for key in ('creativeResult', 'qaResult', 'audioQa'))
            if (creative.get('status') != 'edited' or qa.get('status') != 'passed' or qa.get('issues')
                    or audio.get('status') != 'passed' or audio.get('issues')):
                raise ValueError('自动投稿须完成精切及画面/音轨复审；普通底版可在Web人工选择投稿')
            curation = metadata.get('curation') or {}
            if (curation.get('version') != 1 or curation.get('status') != 'original'
                    or type(curation.get('score')) not in (int, float)
                    or not policy.get('minScore', 90) <= curation['score'] <= 100):
                raise ValueError('缺少严格选材及B站同题核查，旧库存须重新筛选')
            source, window = metadata.get('source') or {}, metadata.get('window') or {}
            if (not source.get('srtPath') or not source.get('mediaPath')
                    or curation.get('sourceWindow') != {key: window.get(key) for key in ('start', 'end')}
                    or ntpath.normcase(ntpath.normpath(curation.get('sourceMediaPath', ''))) != ntpath.normcase(ntpath.normpath(source['mediaPath']))
                    or file_digest(source['srtPath']) != curation.get('sourceSrtSha256')
                    or file_digest(curation.get('evidencePath')) != curation.get('evidenceSha256')):
                raise ValueError('同题核查的素材或窗口已变化，须重新核查')
            report = read_metadata(curation['evidencePath'])
            candidates = [row for row in report.get('candidates', []) if row.get('id') == curation.get('candidateId')]
            decisions = [row for row in report.get('decisions', []) if row.get('candidateId') == curation.get('candidateId')]
            if (len(candidates) != 1 or len(decisions) != 1 or decisions[0].get('status') != 'original'
                    or decisions[0].get('inputDigest') != curation.get('inputDigest')
                    or decisions[0].get('score') != curation.get('score')
                    or str(candidates[0].get('roomId')) != room
                    or any(candidates[0].get(key) != window.get(key) for key in ('start', 'end'))
                    or not decisions[0].get('searches')):
                raise ValueError('同题核查记录不完整或与当前成片不符')
        except (OSError, ValueError, TypeError, KeyError) as error:
            errors.append(f'[QUALITY_POLICY] {label}: {error}')
    return errors
