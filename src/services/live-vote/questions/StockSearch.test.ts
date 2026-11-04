import { lookupStockQuotes, searchStocks } from './StockSearch';
import { PublicSearchEvidence } from './PublicSearchTools';
import { boundedReadEvidence, collectReadCitations } from './ReadToolEvidence';

export function quoteRow(symbol: string, name: string, price: number, index = false) {
  const fields = Array(63).fill('0');
  Object.assign(fields, { 1: name, 2: index ? '.INX' : symbol, 3: String(price), 4: String(price - 1),
    30: '2026-11-04 11:02:41', 31: '1', 32: '1.2', 33: String(price + 1), 34: String(price - 2), 61: index ? 'ZS' : 'GP' });
  return `v_${symbol}="${fields.join('~')}";`;
}
const rows: Record<string, string> = { QQQ: 'us~qqq.oq~纳指100ETF-Invesco~qqq~GP^us~qqqm.oq~QQQM~qqqm~GP',
  AMD: 'us~amd.oq~超威半导体~amd~GP', nvidia: 'us~nvda.oq~Nvidia~nvidia~GP',
  标普500: 'us~inx~标普500~bp500~ZS^sh~513500~标普500ETF博时~etf~QDII-ETF',
  腾讯: 'hk~00700~腾讯控股~tx~GP^us~tcehy.ps~腾讯ADR~tx~GP' };
const read = async (url: URL) => url.hostname === 'smartbox.gtimg.cn' ? `v_hint="${rows[url.searchParams.get('q')!] || ''}";` :
  quoteRow('usQQQ', '纳指100ETF', 600) + quoteRow('usAMD', '超威半导体', 200) + quoteRow('usNVDA', '英伟达', 180) + quoteRow('usINX', '标普500', 7000, true);

test('the reported four-security query resolves separately, quotes in one batch and survives channel payload bounds', async () => {
  const evidence = new PublicSearchEvidence(read);
  const result = await evidence.run('lookup_stock_quotes', { queries: ['QQQ', 'AMD', 'nvidia', '标普'], market: 'US' });
  expect(result).toMatchObject({ hits: [
    { data: { symbol: 'usQQQ', priceUnit: 'USD' } }, { data: { symbol: 'usAMD', priceUnit: 'USD' } },
    { data: { symbol: 'usNVDA', priceUnit: 'USD' } }, { data: { symbol: 'usINX', priceUnit: '点', assetType: '指数' } }
  ], resolutions: [expect.anything(), expect.anything(), expect.anything(), { query: '标普', lookup: '标普500', symbol: 'usINX' }] });
  const bounded = boundedReadEvidence(result), ids = new Set<string>();
  collectReadCitations(bounded.data, ids);
  expect(bounded.truncated).toBe(false); expect(ids.size).toBe(4);
});

test('ambiguous or missing items do not erase successes or silently select an ADR', async () => {
  const result = await lookupStockQuotes(['AMD', '腾讯', '不存在'], 'all', read);
  expect(result.quotes.map(row => row.symbol)).toEqual(['usAMD']);
  expect(result.resolutions.map(row => row.status)).toEqual(['resolved', 'ambiguous', 'not-found']);
});

test('lookup failures are unavailable and preserve successful items', async () => {
  const io = async (url: URL) => { if (url.searchParams.get('q') === 'nvidia') throw new Error('offline'); return read(url); };
  expect((await lookupStockQuotes(['AMD', 'nvidia'], 'US', io)).resolutions[1].status).toBe('unavailable');
  await expect(lookupStockQuotes(['nvidia'], 'US', io)).rejects.toThrow('unavailable');
});

test('ETF results support mainland listings and AMEX suffixes without admitting warrants', async () => {
  const result = await searchStocks('ETF', 'all', async () => 'v_hint="us~spy.am~标普ETF~spy~GP^sh~513500~标普ETF~bp~QDII-ETF^hk~13005~权证~qz~QZ";');
  expect(result.matches.map(row => row.symbol)).toEqual(['usSPY', 'sh513500']);
});

test('explicit market codes bypass fuzzy lookup, keep mixed markets and reject a conflicting market filter', async () => {
  const io = jest.fn(async () => quoteRow('hk00700', '腾讯控股', 400) + quoteRow('sh600519', '贵州茅台', 1500) + quoteRow('usAMD', '超威半导体', 200));
  const result = await lookupStockQuotes(['hk00700', '600519.SH', 'usAMD'], 'all', io);
  expect(result.quotes.map(row => row.currency)).toEqual(['HKD', 'CNY', 'USD']);
  expect(io).toHaveBeenCalledTimes(1);
  expect((await lookupStockQuotes(['hk00700'], 'US', io)).resolutions[0].status).toBe('market-mismatch');
  expect(io).toHaveBeenCalledTimes(1);
});
