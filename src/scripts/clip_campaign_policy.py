"""Resolve explicitly authorized campaign publication without expanding daily rooms."""

import datetime as dt


def resolve_campaign_publication(settings, metadata, timestamp):
    policy = settings.get("automaticPublication") or {}
    room = str(metadata.get("roomId") or "")
    campaign = next((row for row in settings.get("campaigns", [])
                     if row.get("enabled") is True and room in [str(value) for value in row.get("roomIds", [])]), None)
    if not campaign or "automaticPublication" not in (campaign.get("settings") or {}):
        return policy
    start, end = timestamp(campaign.get("startsAt")), timestamp(campaign.get("endsAt"))
    recorded = dt.datetime.strptime(str(metadata.get("recordedAt") or ""), "%Y-%m-%d %H:%M:%S")
    recorded = recorded.replace(tzinfo=dt.timezone(dt.timedelta(hours=8)))
    if not start <= recorded < end:
        raise ValueError("automatic campaign publication requires an in-period source")
    # Queue consumption may happen after the campaign ends; its signed artifact
    # and explicit policy remain checked by the existing publication boundary.
    return campaign["settings"]["automaticPublication"] or {}
