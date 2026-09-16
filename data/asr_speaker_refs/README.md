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
- `mofu_official_chat.wav`: 犬绒Mofu（本人投稿聊天状态，来源交叉核验）
- `hazel_official_game_chat.wav`: 灰泽满Hazel（本人投稿游戏聊天状态，来源交叉核验）

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
- Mofu and Hazel source checks are recorded in their portable `enrollment_candidates/*.enrollment.json` files with `humanAudited: false`. Automated audio/embedding checks are not human listening reviews.
- Hazel's four 8-second exemplars identify 5/6 windows from a separate official video and 7/8 windows from a later opening-chat recording. Eight of 244 legacy control windows become `UNKNOWN` because of competition with Miting; no control switches to another named identity. This is a source-checked reference with a documented recall tradeoff, not a claim of full-stream accuracy.
- For this repo, the current five-person language-collab target is:
  - 岁己 -> `sui.wav`
  - 栞栞 -> `shiori.wav`
  - 瑞娅 -> `rhea.wav`
  - 三理 -> `mit3uri.wav`
  - 弥月 -> `mizuki.wav`

## Repeating enrollment comparisons

`src/scripts/python/enroll_speaker_reference.py` creates a staged WAV from local
clip ranges and checks audio/embedding quality. It does not establish the identity
of the voice. Keep source accounts, continuous content checks, recording dates,
hashes and independent held-out material in the enrollment metadata before
registering a canonical reference. A room owner, filename, or old ASR label alone
is insufficient.

Use `src/scripts/python/diagnose_speaker_match.py` to compare a staged reference
with the actual configured CAM++ row matcher. It reads the selected backend's
threshold, margin, top-k and prototype settings without changing them:

```powershell
python src/scripts/python/diagnose_speaker_match.py --corpus temp/<task>/corpus.json --candidate temp/<task>/candidate.json --report temp/<task>/comparison.json --device cpu
```

The candidate JSON contains `references` (the same reference objects as backend
configuration) and `source_ids` identifying all enrollment source sessions. The
corpus JSON contains `records`, each with a unique `id`, `path`, `start_s`,
`duration_s`, and `split` (`holdout`, `control` or `probe`). A `holdout` also requires
`expected`, `source_id`, and `identity_basis`; its source must not be in candidate
`source_ids`. All media paths resolve from `--project-root`, by default this repo.

The report includes exact reference hashes, production matching parameters,
individual scores/margins, unknowns and named identity changes. `control` means
regression consistency with the old bank; do not present that as independent
identity truth. Source-ID/hash checks detect obvious enrollment leakage, but
edited copies and recordings of the same session still require source review.
Neither this command nor successful embedding extraction promotes any reference
or claims a human audition.

CAM++ embeddings are batched only when waveform sample counts are equal. The
upstream FunASR model pads variable-length features and ignores their lengths in
statistics pooling, which otherwise makes a short voice's embedding depend on
longer batch partners. This also applies when extracting reference prototypes.
Grouping preserves the original waveform boundaries and restores output order;
it does not pad/crop speech or lower identity thresholds. One resource monitor
covers the extraction stage while each model batch still honors resource limits.
