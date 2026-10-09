import { collectSpokenQuantityValues, supportedQuantitySpans } from './quantityEvidence';

describe('explicit spoken quantities', () => {
  test.each([
    ['Sc要三十块钱喊两句咋了', '30元SC'],
    ['两百零五块钱', '205元'], ['一百零二元', '102元'],
    ['十二次', '12次'], ['一十个', '10个'], ['两千零三人', '2003人'],
    ['三十 岁', '30岁'], ['一千零一十元', '1010元'],
  ])('accepts an equivalent complete quantity and preserves its copy span: %s -> %s', (source, copy) => {
    const spans = supportedQuantitySpans(`金额：${copy}。`, collectSpokenQuantityValues([source]));
    expect(spans).toHaveLength(1);
    expect(`金额：${copy}。`.slice(spans[0].start, spans[0].end)).toBe(copy.replace(/SC$/u, ''));
  });

  test.each([
    ['三十块钱', '300元'], ['三十块钱', '30次'], ['三十人', '30个'],
    ['三十个', '30岁'], ['三十元', '30万元'], ['三十元', '30.5元'],
    ['十九点五十二分', '52元'], ['二零二零年十二月', '2020元'],
    ['三十万块钱', '30元'], ['二三十元', '30元'], ['一百二元', '102元'],
    ['一百二元', '120元'], ['三十点五元', '30元'], ['三十.五元', '30元'],
    ['一千二元', '1002元'], ['两十元', '20元'], ['一百十元', '110元'],
    ['1三十元', '30元'], ['三十多元', '30元'], ['三十块', '30元'],
    ['负三十元', '30元'], ['负 三十元', '30元'], ['- 三十元', '30元'],
    ['三十元', '-30元'], ['三十元', '30美元'],
    ['三十人次', '30人'], ['三十个月', '30个'], ['三十次方', '30次'],
    ['三十元素', '30元'], ['三十元宵', '30元'],
    ['几十元', '10元'], ['数十元', '10元'], ['半十元', '10元'],
  ])('does not guess or detach a value from its unit: %s -> %s', (source, copy) => {
    expect(supportedQuantitySpans(copy, collectSpokenQuantityValues([source]))).toEqual([]);
  });

  test('never assembles a number and its unit from different evidence rows', () => {
    expect(supportedQuantitySpans('30元', collectSpokenQuantityValues(['三十', '块钱']))).toEqual([]);
    expect(supportedQuantitySpans('130元', collectSpokenQuantityValues(['一百', '三十元']))).toEqual([]);
  });
});
