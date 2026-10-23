"""Explicit acceptance of existing activity cuts, distinct from independent review."""
import copy


METHOD = 'explicit_user_feedback'


def accept_activities(metadata, note):
    previous_review = copy.deepcopy(metadata.get('activityReview'))
    for event in metadata.get('activities') or []:
        previous = copy.deepcopy(event.get('verification'))
        previous_issues = copy.deepcopy(event.get('reviewIssues') or [])
        event['verification'] = {
            'method': METHOD, 'decision': 'accepted', 'authority': 'user',
            'acceptanceMode': 'feedback', 'audioVisualReviewed': False, 'note': note,
            'window': {key: event[key] for key in ('start', 'end')},
            'previousVerification': previous, 'previousReviewIssues': previous_issues,
            'previousPackageReview': previous_review,
        }
        event['reviewIssues'] = []


def validate_feedback(metadata):
    review = metadata.get('activityReview') or {}
    accepted = [event for event in metadata.get('activities') or []
                if (event.get('verification') or {}).get('method') == METHOD]
    if not accepted and review.get('acceptanceMode') != 'feedback':
        return
    if (review.get('authority') != 'human' or review.get('acceptanceMode') != 'feedback'
            or review.get('audioVisualReviewed') is not False or not str(review.get('note') or '').strip()
            or len(accepted) != len(metadata.get('activities') or [])):
        raise ValueError('activity feedback needs explicit publication acceptance')
    for event in accepted:
        evidence = event['verification']
        if (evidence.get('authority') != 'user' or evidence.get('decision') != 'accepted'
                or evidence.get('acceptanceMode') != 'feedback' or evidence.get('audioVisualReviewed') is not False
                or evidence.get('note') != review['note'] or 'previousVerification' not in evidence
                or evidence.get('window') != {key: event[key] for key in ('start', 'end')}):
            raise ValueError('activity feedback acceptance changed')
