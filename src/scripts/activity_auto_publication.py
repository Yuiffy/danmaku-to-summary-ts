"""Automatic activity approval without claiming a human reviewed the material."""
import datetime as dt
import json
from pathlib import Path

POLICY_VERSION = 'stream-activity-v1'
CHECKS = ('content', 'boundaries', 'titles', 'visuals', 'policy')


def timestamp(value):
    parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('automatic activity timestamp requires a timezone')
    return parsed


def policy_for(metadata, config):
    settings = config.get('streamActivityClips') or {}
    policy = settings.get('automaticPublication') or {}
    room = str(metadata.get('roomId') or (metadata.get('upload') or {}).get('roomId') or '')
    if (settings.get('enabled') is not True or policy.get('mode') != 'auto'
            or metadata.get('activityAutomaticPublicationRequired') is not True
            or metadata.get('kind') not in ('songs', 'watch')
            or policy.get('policyVersion') != POLICY_VERSION or not str(policy.get('authorizationNote') or '').strip()
            or room not in [str(item) for item in policy.get('roomIds', [])]
            or room not in [str(item) for item in settings.get('roomIds', [])]
            or (settings.get(metadata.get('kind')) or {}).get('enabled') is False):
        raise ValueError('automatic activity policy does not authorize this submission')
    if timestamp(metadata.get('generatedAt')) < timestamp(policy.get('activatedAt')):
        raise ValueError('activity predates automatic publication activation')
    return {key: policy.get(key) for key in ('mode', 'policyVersion', 'roomIds', 'activatedAt', 'authorizationNote')}


def ready(metadata, config, check_artifacts, content_digest):
    policy = policy_for(metadata, config)
    check_artifacts(metadata)
    source = metadata['sourceSnapshot']
    stat = Path(source['mediaPath']).stat()
    if str(stat.st_size) != source['mediaBytes'] or str(stat.st_mtime_ns) != source['mediaMtimeNs']:
        raise ValueError('activity source changed before automatic review')
    for key in ('srt', 'xml'):
        if source.get(key + 'Path'):
            import hashlib
            actual = hashlib.sha256(Path(source[key + 'Path']).read_bytes()).hexdigest()
            if actual != source[key + 'Sha256']:
                raise ValueError('activity source evidence changed before automatic review')
    events = metadata.get('activities') or []
    if not events or (metadata.get('transcript') or {}).get('timingReliable') is False:
        raise ValueError('activity source timing or coverage remains uncertain')
    for event in events:
        verification = event.get('verification') or {}
        if (verification.get('decision') != 'keep' or event.get('startObserved') is not True
                or event.get('endObserved') is not True or event.get('reviewIssues')
                or verification.get('method') != 'independent_local_asr'):
            raise ValueError('activity performance/viewing or complete boundaries remain uncertain')
    return dict(version=1, policyVersion=POLICY_VERSION, policy=policy, contentSha256=content_digest(metadata))


def validate(metadata, config, check_artifacts, content_digest):
    review = metadata.get('activityReview') or {}
    bound = ready(metadata, config, check_artifacts, content_digest)
    if (review.get('version') != 1 or review.get('status') != 'approved' or metadata.get('uploadReady') is not True
            or review.get('authority') != 'automatic' or review.get('policyVersion') != POLICY_VERSION
            or review.get('policy') != bound['policy'] or review.get('contentSha256') != bound['contentSha256']
            or review.get('issues') != [] or any(review.get('checks', {}).get(key) is not True for key in CHECKS)
            or not review.get('proofPath') or not review.get('proofSha256')):
        raise ValueError('automatic activity final review is missing or changed')
    import hashlib
    proof_path = Path(review['proofPath'])
    if hashlib.sha256(proof_path.read_bytes()).hexdigest() != review['proofSha256']:
        raise ValueError('automatic activity final review proof changed')
    proof = json.loads(proof_path.read_text(encoding='utf-8-sig'))
    if (proof.get('binding') != bound or proof.get('status') != 'passed' or proof.get('issues') != []
            or proof.get('checks') != review.get('checks')):
        raise ValueError('automatic activity proof is not bound to this submission')


def approve(path, proof_path, config, check_artifacts, content_digest):
    import hashlib
    path, proof_path = Path(path).resolve(), Path(proof_path).resolve()
    metadata = json.loads(path.read_text(encoding='utf-8-sig'))
    binding = ready(metadata, config, check_artifacts, content_digest)
    proof = json.loads(proof_path.read_text(encoding='utf-8-sig'))
    if (proof.get('binding') != binding or proof.get('status') != 'passed' or proof.get('issues') != []
            or any(proof.get('checks', {}).get(key) is not True for key in CHECKS)):
        raise ValueError('automatic activity final review did not pass')
    metadata['activityReview'] = dict(version=1, status='approved', authority='automatic',
        policyVersion=POLICY_VERSION, policy=binding['policy'], contentSha256=binding['contentSha256'],
        checks=proof['checks'], issues=[], reviewedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
        proofPath=str(proof_path), proofSha256=hashlib.sha256(proof_path.read_bytes()).hexdigest())
    metadata['uploadReady'] = True
    validate(metadata, config, check_artifacts, content_digest)
    temporary = path.with_suffix('.automatic.tmp')
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    temporary.replace(path)
    return path
