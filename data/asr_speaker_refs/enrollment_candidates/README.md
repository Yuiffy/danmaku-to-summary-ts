# Staged speaker-reference enrollment

Candidate WAVs and reports created by `src/scripts/python/enroll_speaker_reference.py` belong here. They are **not** production references. `shiori_v2.enrollment.json` and `miting_v2.enrollment.json` are starting manifests from local solo archives; every `reviewed` entry must be manually checked and set to `true` before production promotion.

Use reviewed, clean solo clips only:

- 小栞: speech from at least two solo sessions; optional low-accompaniment singing clips must be separately identified and limited.
- 米汀: speech from at least two solo talk/game sessions; exclude song/BGM-heavy, collaboration, remote-voice, and other-speaker regions.

A clip manifest has this form:

```json
{
  "speaker": "栞栞",
  "key": "shiori",
  "clips": [
    {
      "source": "D:/files/videos/DDTV录播/.../recording.flv",
      "startSeconds": 120,
      "durationSeconds": 8,
      "kind": "speech",
      "reviewed": true
    }
  ]
}
```

Build a candidate without replacing production audio:

```powershell
python src/scripts/python/enroll_speaker_reference.py enrollment.json --output-dir data/asr_speaker_refs/enrollment_candidates
```

Promotion requires a held-out CAM++ report showing no 米汀 acceptance on the 小栞 solo-song negative set, acceptable recall for both broadcasters' speech, and manual review of borderline results. Back up the prior canonical WAV, then record source clips, processing, report path, and SHA-256 in `manifest.json`.
