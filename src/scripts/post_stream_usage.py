"""Read saved post-stream artifacts without generating or publishing content."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
from pathlib import Path

import yaml

ROOMS = ('25788785', '26966466', '30655190', '31368705')
REPLY_SUFFIX = '_\u665a\u5b89\u56de\u590d.md'
TEXT_PRICES = {'gpt-5.6-luna': (0.20, 0.02, 0.25, 1.20),
               'gpt-5.6-sol': (4.0, 0.4, 5.0, 20.0)}


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value


def read_json(path):
    value = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    if not isinstance(value, dict):
        raise ValueError('Artifact must contain a JSON object')
    return value


def read_reply(path):
    text = Path(path).read_bytes().decode('utf-8-sig')
    header = re.match(r'^---\r?\n(.*?)\r?\n---\r?\n', text, re.S)
    if not header:
        return {}, text
    meta = yaml.safe_load(header.group(1))
    return meta if isinstance(meta, dict) else {}, text[header.end():].strip()


def request_record(attempt, stage, artifact, index, defaults=None):
    if not isinstance(attempt, dict):
        raise ValueError('Attempt metadata must be an object')
    defaults = defaults or {}
    usage = attempt.get('usage') or {}
    details = usage.get('input_tokens_details') or usage.get('prompt_tokens_details') or {}
    output_details = usage.get('output_tokens_details') or {}
    prompt = number(attempt.get('promptTokens', usage.get('input_tokens', usage.get('prompt_tokens'))))
    output = number(attempt.get('completionTokens', usage.get('output_tokens', usage.get('completion_tokens'))))
    cached = number(attempt.get('cachedTokens', details.get('cached_tokens')))
    write = number(attempt.get('cacheWriteTokens', details.get('cache_write_tokens')))
    model = attempt.get('model') or defaults.get('model')
    price = TEXT_PRICES.get(model)
    estimate = None
    image_estimate = None
    if stage != 'image' and price and None not in (prompt, output, cached):
        write = write or 0
        im, om = (2, 1.5) if prompt > 272000 else (1, 1)
        estimate = ((max(0, prompt - cached - write) * price[0] + cached * price[1] + write * price[2]) * im
                    + output * price[3] * om) / 1e6
    image_input = number(details.get('image_tokens'))
    text_input = number(details.get('text_tokens'))
    image_output = number(output_details.get('image_tokens'))
    if stage == 'image' and model == 'gpt-image-2' and None not in (image_input, text_input, image_output):
        image_estimate = (image_input * 8.0 + text_input * 5.0 + image_output * 30.0) / 1e6
    return {'stage': stage, 'phase': attempt.get('phase'), 'model': model, 'provider': attempt.get('provider') or defaults.get('provider'),
            'status': attempt.get('status'), 'promptTokens': prompt, 'cachedTokens': cached,
            'outputTokens': output, 'reasoningTokens': number(attempt.get('reasoningTokens', output_details.get('reasoning_tokens'))),
            'knownTokenTotal': prompt + output if None not in (prompt, output) else None,
            'estimatedTextUsd': estimate, 'requestId': attempt.get('requestId'), 'responseId': attempt.get('responseId'),
            'estimatedUncachedImageUsd': image_estimate,
            'sharedPromptCacheKey': attempt.get('sharedPromptCacheKey'),
            'usageUnknown': bool(attempt.get('usageUnknown') or attempt.get('usageFinal') is False
                                 or prompt is None or output is None),
            'artifact': str(artifact), 'attemptIndex': index}


def inspect_recording(reply_path):
    reply_path = Path(reply_path)
    base = str(reply_path)[:-len(REPLY_SUFFIX)]
    reply_meta, body = read_reply(reply_path) if reply_path.exists() else ({}, '')
    canonical_path = Path(base + '_REPLY_SUMMARY.json')
    canonical = read_json(canonical_path) if canonical_path.exists() else None
    rows = []
    shared_reply = False
    if canonical:
        rows.extend(request_record(a, 'reply-summary', canonical_path, i, canonical)
                    for i, a in enumerate(canonical.get('attempts') or []))
        shared_reply = reply_path.exists() and canonical.get('status') == 'success' and canonical.get('replyBodySha256') == hashlib.sha256(body.encode('utf-8')).hexdigest()
    if not shared_reply:
        rows.extend(request_record(a, 'goodnight', reply_path, i, reply_meta)
                    for i, a in enumerate(reply_meta.get('attempts') or []))
    files = {'reply': str(reply_path) if reply_path.exists() else None}
    summary_content = None
    comic_full = False
    for suffix, stage in [('_LIVE_CONTENT.json', 'summary'), ('_COMIC_SCRIPT_META.json', 'comic-script'), ('_COMIC_FACTORY_META.json', 'image')]:
        artifact = Path(base + suffix)
        if not artifact.exists():
            continue
        files[stage] = str(artifact)
        data = read_json(artifact)
        generation = data.get('generation') or data
        if stage == 'comic-script':
            comic_full = bool(data.get('fullLiveSourceSha256'))
        if stage == 'summary':
            summary_content = data.get('content')
            if canonical and generation.get('sharedUsagePath') == canonical_path.name:
                continue
        rows.extend(request_record(a, stage, artifact, i, generation) for i, a in enumerate(generation.get('attempts') or []))
    # Source diagnostic drafts contain real attempts missing from final Markdown.
    for diagnostic in reply_path.parent.iterdir():
        if not diagnostic.name.startswith(reply_path.stem + '_ATTEMPT') or diagnostic.suffix != '.md':
            continue
        meta, _ = read_reply(diagnostic)
        attempts = meta.get('attempts') or [{'status': 'legacy-diagnostic-without-usage', 'usageUnknown': True}]
        rows.extend(request_record(a, 'goodnight-rejected', diagnostic, i, meta or reply_meta) for i, a in enumerate(attempts))
    unique, seen = [], set()
    for row in rows:
        identity = row['responseId'] or row['requestId']
        if identity and identity in seen:
            continue
        if identity:
            seen.add(identity)
        unique.append(row)
    tokens = lambda selected, key: sum(r[key] for r in selected if r[key] is not None)
    text = [r for r in unique if r['stage'] != 'image']
    images = [r for r in unique if r['stage'] == 'image']
    room = reply_path.name.split('-')[1] if reply_path.name.startswith('\u5f55\u5236-') else canonical.get('roomId') if canonical else None
    image_path = Path(base + '_COMIC_FACTORY.png')
    files['image'] = str(image_path) if image_path.exists() else None
    full_path = Path(base + '_FULL_LIVE_CONTEXT.json')
    prefix = read_json(full_path).get('sharedPrefixSha256') if full_path.exists() else None
    reply_full = bool(prefix and any(a.get('sharedPromptCacheKey') == prefix for a in reply_meta.get('attempts') or []))
    mode = canonical.get('mode') if canonical and (shared_reply or not reply_path.exists()) else 'full-separate' if reply_full and comic_full else 'mixed' if summary_content or reply_full or comic_full else 'filtered'
    return {'roomId': room, 'recording': Path(base).name, 'day': reply_path.parent.name,
            'mode': mode, 'attemptedMode': canonical.get('mode') if canonical else None,
            'status': canonical.get('status') if canonical else 'legacy-artifacts' if reply_path.exists() else 'incomplete',
            'reply': body, 'overview': summary_content, 'files': files, 'requests': unique,
            'inputModes': {'reply': 'combined-full' if shared_reply else 'full' if reply_full else 'filtered-or-unverified',
                           'comicScript': 'full' if comic_full else 'filtered-or-unverified', 'summary': 'present' if summary_content else 'absent'},
            'inputTokens': tokens(text, 'promptTokens'), 'cachedTokens': tokens(text, 'cachedTokens'),
            'outputTokens': tokens(text, 'outputTokens'), 'estimatedTextUsd': sum(r['estimatedTextUsd'] or 0 for r in text),
            'estimatedUncachedImageUsd': sum(r['estimatedUncachedImageUsd'] or 0 for r in images),
            'unknownTextUsageRequests': sum(r['usageUnknown'] for r in text),
            'unpricedTextRequests': sum(r['estimatedTextUsd'] is None for r in text),
            'imageInputTokens': tokens(images, 'promptTokens'), 'imageOutputTokens': tokens(images, 'outputTokens'),
            'unknownImageUsageRequests': sum(r['usageUnknown'] for r in images),
            'unpricedImageRequests': sum(r['estimatedUncachedImageUsd'] is None for r in images),
            'accountingUnknownRequests': sum(r['usageUnknown'] or (r['estimatedUncachedImageUsd'] is None if r['stage'] == 'image'
                                          else r['estimatedTextUsd'] is None) for r in unique)}


def collect(root, since, until, room_ids):
    records, errors = [], []
    for room in sorted(Path(root).iterdir()):
        if not room.is_dir() or room.name.split('_')[0] not in room_ids:
            continue
        for day in sorted(room.iterdir()):
            if not day.is_dir() or not re.fullmatch(r'\d{4}_\d{2}_\d{2}', day.name) or not since <= day.name <= until:
                continue
            suffixes = (REPLY_SUFFIX, '_REPLY_SUMMARY.json', '_LIVE_CONTENT.json', '_COMIC_SCRIPT_META.json', '_COMIC_FACTORY_META.json')
            bases = {file.name[:-len(suffix)] for file in day.iterdir() if file.is_file()
                     for suffix in suffixes if file.name.endswith(suffix)}
            for base in sorted(bases):
                reply = day / (base + REPLY_SUFFIX)
                try:
                    records.append(inspect_recording(reply))
                except (OSError, ValueError, yaml.YAMLError) as error:
                    errors.append({'file': str(reply), 'error': str(error)})
    return records, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--since', default=(dt.date.today() - dt.timedelta(days=7)).isoformat())
    parser.add_argument('--until', default=dt.date.today().isoformat())
    parser.add_argument('--rooms', default=','.join(ROOMS))
    parser.add_argument('--root')
    parser.add_argument('--output', help='Optional JSON report output')
    args = parser.parse_args()
    os.environ.setdefault('NODE_ENV', 'production')
    from config_loader import get_config
    root = args.root or get_config().get('storage', {}).get('basePath')
    if not root or not Path(root).is_dir():
        parser.error('Recording root does not exist')
    since, until = (dt.date.fromisoformat(value).strftime('%Y_%m_%d') for value in (args.since, args.until))
    if since > until:
        parser.error('--since must not follow --until')
    records, errors = collect(root, since, until, set(args.rooms.split(',')))
    result = {'generatedAt': dt.datetime.now().astimezone().isoformat(), 'sourceRoot': root,
              'since': args.since, 'until': args.until, 'records': records, 'errors': errors,
              'pricing': '2026-09-08 official USD equivalents, not gateway billing. Images priced as uncached gpt-image-2 inputs. Missing cache-write usage assumes zero writes.',
              'pricingSource': 'https://developers.openai.com/api/docs/pricing',
              'limits': ['Known saved attempts only; absent usage is not free.', 'Historical anonymous retries cannot always be deduplicated.',
                         'No source artifacts were modified and no network requests were made.']}
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('| Room | Ready/records | Known text input | Cached | Known text output | Text USD | Image USD (uncached) | Image input/output | Unknown/unpriced requests |')
    print('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for room in args.rooms.split(','):
        selected = [r for r in records if r['roomId'] == room]
        total = lambda key: sum(r[key] for r in selected)
        ready = sum(bool(r['files']['reply']) for r in selected)
        print(f'| {room} | {ready}/{len(selected)} | {total("inputTokens")} | {total("cachedTokens")} | {total("outputTokens")} | '
              f'${total("estimatedTextUsd"):.5f} | ${total("estimatedUncachedImageUsd"):.5f} | {total("imageInputTokens")}/{total("imageOutputTokens")} | '
              f'{total("accountingUnknownRequests")} |')
    print(f'Artifact read errors: {len(errors)}. USD values are incomplete estimates, not an invoice.')
    if args.output:
        print(f'Detailed results and output paths: {Path(args.output).resolve()}')


if __name__ == '__main__':
    main()
