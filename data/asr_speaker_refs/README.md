# ASR Speaker References

This directory stores the canonical speaker reference clips used by the SenseVoice + CAM++ diarization flow.

Current mapping:

- `sui.wav`: 岁己SUI
- `shiori.wav`: 栞栞
- `shiori_recent_solo.wav`: 栞栞（2026-07-20/21 近期单人聊天状态）
- `shiori_recent_august.wav`: 栞栞（2026-08-23 近期单人聊天状态）
- `shiori_recent_august_alt.wav`: 栞栞（2026-08-23 另一声学状态）
- `shiori_recent_august_24.wav`: 栞栞（2026-08-24 近期单人聊天状态）
- `shiori_august_24_fragmented.wav`: 栞栞（2026-08-24 被聚类切碎的声学状态）
- `shiori_excited_game.wav`: 栞栞（游戏/兴奋状态）
- `shiori_singing.wav`: 栞栞（2026-08-19 唱歌状态）
- `shiori_singing_august_24.wav`: 栞栞（2026-08-24 1249 片段的唱歌状态）
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
- `shiori_recent_solo.wav` uses 8 reviewed speech clips from the 2026-07-20 and 2026-07-21 solo streams to cover the newer microphone/voice state.
- `shiori_recent_august.wav` uses 8 reviewed speech clips from the 2026-08-23 solo stream to cover the August microphone/voice state.
- `shiori_recent_august_alt.wav` uses 8 reviewed speech clips from the same solo stream's alternate acoustic state; it remains a separate prototype instead of being averaged into the main chat state.
- `shiori_recent_august_24.wav` uses 8 reviewed speech clips from the 2026-08-24 solo stream and passed 8/8 CAM++ embedding validation.
- `shiori_august_24_fragmented.wav` uses 8 user-confirmed `SPEAKER_03` speech clips from the same solo stream and passed 8/8 CAM++ embedding validation; it remains a separate prototype.
- `shiori_singing.wav` uses 8 reviewed singing clips from the 2026-08-19 solo karaoke stream; singing is kept as an independent state so it does not replace chat references.
- `shiori_singing_august_24.wav` uses 8 user-confirmed singing clips from the 1249 solo stream and passed 8/8 CAM++ embedding validation; it is a separate dated singing state.
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
