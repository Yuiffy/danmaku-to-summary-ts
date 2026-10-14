import { sourceWindowSubtitles, subtitleRows, timeSeconds } from './subtitles';

it('preserves absolute source times and includes only overlapping cues at candidate boundaries', () => {
  const text = '\uFEFF1\r\n00:00:09,500 --> 00:00:10,500\r\n开头跨界\r\n\r\n2\r\n00:00:10,500 --> 00:00:11,000\r\n原话\r\n第二行\r\n\r\n3\r\n00:00:11,000 --> 00:00:12,000\r\n范围外\r\n';
  const rows = subtitleRows(sourceWindowSubtitles(text, 10, 11));
  expect(rows.map(row => row.id)).toEqual(['1', '2']);
  expect(rows[0].at).toBe(9.5); expect(rows[1].text).toBe('原话\n第二行');
  expect(timeSeconds('00:45:42')).toBe(2742); expect(timeSeconds('00:60:00')).toBeUndefined();
  expect(timeSeconds('00:00:01.2')).toBe(1.2); expect(timeSeconds(-1)).toBeUndefined();
});
