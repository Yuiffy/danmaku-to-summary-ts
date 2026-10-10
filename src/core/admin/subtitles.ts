/** Convert a display copy of SRT to WebVTT; never modify the reviewed source. */
export function srtToVtt(srt: string): string {
  return 'WEBVTT\n\n' + srt.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/gu, '$1.$2');
}
