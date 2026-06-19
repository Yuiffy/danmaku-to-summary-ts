# ASR Speaker References

This directory stores the canonical speaker reference clips used by the SenseVoice + CAM++ diarization flow.

Current mapping:

- `sui.wav`: 岁己SUI
- `shiori.wav`: 栞栞
- `rhea.wav`: 瑞娅
- `mit3uri.wav`: 三理
- `seki.wav`: 星汐Seki
- `mizuki.wav`: 弥月Mizuki
- `miting.wav`: 米汀
- `harei.wav`: 花礼Harei

Notes:

- `manifest.json` is the source of truth for clip metadata.
- `sui.wav`, `shiori.wav`, and `rhea.wav` were rebuilt on 2026-05-31 from pre-hotel solo streams on 2026-05-26.
- `shiori.wav` uses 10 clips from the 2026-05-26 morning stream plus 10 clips from the 2026-05-26 evening stream to reduce single-session bias.
- `mit3uri.wav` was built on 2026-06-19 from 20 subtitle-aligned clips x 8 seconds from 三理's 2026-06-16 solo morning stream.
- Each rebuilt Mixup target reference uses 20 subtitle-aligned clips x 8 seconds, converted to 16 kHz mono WAV with light highpass/lowpass/loudness normalization.
- Previous versions were backed up under `data/asr_speaker_refs/backup_20260531_before_rebuild/`.
- Keep each reference clip as a clean single-speaker sample when possible.
- For this repo, the current five-person language-collab target is:
  - 岁己 -> `sui.wav`
  - 栞栞 -> `shiori.wav`
  - 瑞娅 -> `rhea.wav`
  - 三理 -> `mit3uri.wav`
  - 弥月 -> `mizuki.wav`
