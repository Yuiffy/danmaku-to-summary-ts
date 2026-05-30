# ASR Speaker References

This directory stores the canonical speaker reference clips used by the SenseVoice + CAM++ diarization flow.

Current mapping:

- `sui.wav`: 岁己SUI
- `shiori.wav`: 栞栞
- `rhea.wav`: 瑞娅
- `seki.wav`: 星汐Seki
- `mizuki.wav`: 弥月Mizuki
- `miting.wav`: 米汀
- `harei.wav`: 花礼Harei

Notes:

- `manifest.json` is the source of truth for clip metadata.
- `sui.wav` is currently rebuilt from `D:\files\videos\剪映输出\岁己按钮音声输出\20240903找孩子们\自然而然的直播.MP3`.
- `shiori.wav` is currently rebuilt from `D:\files\videos\DDTV录播\26966466_栞栞Shiori\2026_05_28\录制-26966466-20260528-225805-019-很卡的网络_merged.m4a`.
- Keep each reference clip as a clean single-speaker sample when possible.
- For this repo, the main three-person mixup target is:
  - 岁己 -> `sui.wav`
  - 栞栞 -> `shiori.wav`
  - 瑞娅 -> `rhea.wav`
