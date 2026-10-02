const { parseCopyProposal } = require('./stream_game_editorial');
describe('factual game chapter repair proposals',()=>{
  const parse=(value:any,chapter:any={kind:'phase'})=>parseCopyProposal({text:JSON.stringify(value)},chapter);
  const proposal={title:'战后讨论与湖区探索',description:'讨论此前战斗，随后查看地图并沿水域探索。',reason:'Original phase words and water-traversal frames'};
  test('a supported draft changes copy without granting review or changing boundaries',()=>{
    expect(parse(proposal)).toEqual(proposal);
    expect(()=>parse({...proposal,description:''})).toThrow(/Invalid factual/);
  });
  test('a separately verified literal Boss title stays locked and names cannot be discarded',()=>{
    expect(()=>parse(proposal,{kind:'boss',nameEvidence:'熔炉骑士'})).toThrow(/discard a verified name/);
    const chapter={kind:'boss',title:'接肢葛瑞克战',nameEvidence:'接肢 葛瑞克',nameEvidenceSource:'original_frame'};
    expect(()=>parse({...proposal,title:'接肢葛瑞克挑战'},chapter)).toThrow(/discard a verified name/);
    expect(parse({...proposal,title:chapter.title},chapter).title).toBe(chapter.title);
  });
});
