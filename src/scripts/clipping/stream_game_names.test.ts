const { parseNameReview } = require('./stream_game_names');
describe('game chapter names from literal original frames', () => {
  const chapter = { proposedTitle: '接肢葛瑞克战' }, frames = [{ index: 1, time: 123 }];
  const row = { supported: true, reason: 'Original Boss health bar spells the name',
    label: '接肢 葛瑞克', kind: 'boss', frameIndex: 1, activity: 'gameplay' };
  const parse = (value: any) => parseNameReview({ text: JSON.stringify(value) }, chapter, frames);
  test('a visible literal name may recover a subtitle-downgraded title', () => {
    expect(parse(row)).toMatchObject({ supported: true, label: '接肢 葛瑞克' });
    expect(parse({ supported: false, reason: 'A distant enemy has no readable label' }).supported).toBe(false);
  });
  test('a guess, unrelated label, replay or unknown frame cannot ground a name', () => {
    for (const patch of [{ label: '熔炉骑士' }, { label: '' }, { frameIndex: 2 }, { activity: 'watching_game' }, { kind: 'character' }]) {
      expect(() => parse({ ...row, ...patch })).toThrow(/literal visible label/);
    }
  });
});
