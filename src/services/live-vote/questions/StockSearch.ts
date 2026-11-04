import { PublicDataRead } from './PublicDataClient';

export type StockMarket = 'US' | 'HK' | 'CN';
export interface StockQuote {
  symbol: string; name: string; market: StockMarket; currency: string;
  assetType: '股票/ETF' | '指数'; priceUnit: string;
  price: number; previousClose: number | null; open: number | null;
  change: number | null; changePercent: number | null; high: number | null; low: number | null;
  sourceTime: string; sourceTimeZone: string;
}

export function stockSymbol(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid stock symbol');
  const symbol = value.normalize('NFKC').trim();
  const cn = /^(sh|sz|bj)(\d{6})$/iu.exec(symbol);
  // Explicit exchange is required for mainland codes (000001 can be a stock or an index).
  if (cn) return cn[1].toLowerCase() + cn[2];
  const suffix = /^(\d{6})\.(SH|SZ|BJ)$/iu.exec(symbol);
  if (suffix) return suffix[2].toLowerCase() + suffix[1];
  const hk = /^(?:hk(\d{1,5})|(\d{1,5})\.HK)$/iu.exec(symbol);
  if (hk) return 'hk' + (hk[1] || hk[2]).padStart(5, '0');
  const ticker = symbol.startsWith('us') ? symbol.slice(2) : symbol.replace(/\.US$/iu, '');
  const us = /^([A-Z][A-Z0-9]{0,9}(?:[.-][A-Z])?)$/iu.exec(ticker);
  if (us) return 'us' + us[1].toUpperCase();
  throw new Error('Invalid stock symbol');
}

function numeric(value: string | undefined): number | null {
  if (!value || !/^-?\d+(?:\.\d+)?$/u.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Tencent uses different timestamp formats across markets; US timezone is not declared. */
export function parseStockQuotes(text: string, symbols: string[]): StockQuote[] {
  const quotes: StockQuote[] = [];
  for (const match of text.matchAll(/v_([a-zA-Z0-9_.-]+)="([^"\r\n]*)"/gu)) {
    const symbol = match[1];
    if (!symbols.includes(symbol) || quotes.some(quote => quote.symbol === symbol)) continue;
    const fields = match[2].split('~'), price = numeric(fields[3]);
    const sourceTime = fields[30];
    if (fields.length < 36 || !fields[1]?.trim() || fields[1].length > 100 || price === null || price <= 0 ||
        !/^(?:\d{14}|\d{4}[-/]\d{2}[-/]\d{2} \d{2}:\d{2}:\d{2})$/u.test(sourceTime)) continue;
    const market: StockMarket = symbol.startsWith('us') ? 'US' : symbol.startsWith('hk') ? 'HK' : 'CN';
    const currency = market === 'US' ? 'USD' : market === 'HK' ? 'HKD' : 'CNY';
    const index = fields[2]?.startsWith('.') || fields.includes('ZS');
    quotes.push({ symbol, name: fields[1], market, currency, assetType: index ? '指数' : '股票/ETF', priceUnit: index ? '点' : currency,
      price, previousClose: numeric(fields[4]), open: numeric(fields[5]), change: numeric(fields[31]),
      changePercent: numeric(fields[32]), high: numeric(fields[33]), low: numeric(fields[34]), sourceTime,
      sourceTimeZone: market === 'US' ? '上游未标明时区，不作换算' : 'Asia/Shanghai' });
  }
  return quotes;
}

export async function searchStocks(query: string, market: StockMarket | 'all', read: PublicDataRead) {
  const url = new URL('https://smartbox.gtimg.cn/s3/');
  url.search = new URLSearchParams({ q: query, t: 'all' }).toString();
  const raw = await read(url, 'gb18030');
  const body = /^\s*v_hint="([^"\r\n]*)";?\s*$/u.exec(raw)?.[1];
  if (body === undefined) throw new Error('Invalid stock search response');
  const text = body.replace(/\\u([\da-f]{4})/giu, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const matches: Array<{ symbol: string; name: string; market: StockMarket; type: string }> = [];
  for (const row of text.split('^')) {
    const [exchange, code, name, , type] = row.split('~');
    if (!['sh', 'sz', 'bj', 'hk', 'us'].includes(exchange) || !['GP', 'ZS', 'ETF', 'QDII-ETF'].includes(type) || !name || name.length > 100) continue;
    const rowMarket: StockMarket = exchange === 'us' ? 'US' : exchange === 'hk' ? 'HK' : 'CN';
    if (market !== 'all' && market !== rowMarket) continue;
    try {
      const symbol = stockSymbol(exchange + (exchange === 'us' ? code.replace(/\.(?:oq|n|ps|a|am)$/iu, '') : code));
      if (!matches.some(item => item.symbol === symbol)) matches.push({ symbol, name, market: rowMarket, type: type === 'ZS' ? '指数' : /ETF/iu.test(type + name) ? 'ETF' : '股票' });
    } catch { /* Unsupported asset identifiers cannot become quote requests. */ }
  }
  return { matches: matches.slice(0, 8), notice: '同名或跨市场证券须核对名称、市场和代码；不要猜测用户所指股票。' };
}

/** Resolve each requested security independently; never let an ambiguous/missing item erase other quotes. */
export async function lookupStockQuotes(queries: string[], market: StockMarket | 'all', read: PublicDataRead) {
  const resolutions = [];
  for (const query of queries) {
    // A common index abbreviation is expanded explicitly and retained in the result.
    const lookup = /^(?:标普|标普指数|S&P\s*500|SPX)$/iu.test(query) ? '标普500' : query;
    try {
      if (/^(?:us[A-Z]|(?:hk|sh|sz|bj)\d)|\.(?:US|HK|SH|SZ|BJ)$/iu.test(query)) {
        const symbol = stockSymbol(query);
        const codeMarket: StockMarket = symbol.startsWith('us') ? 'US' : symbol.startsWith('hk') ? 'HK' : 'CN';
        resolutions.push({ query, lookup, status: market === 'all' || market === codeMarket ? 'resolved' : 'market-mismatch',
          symbol: market === 'all' || market === codeMarket ? symbol : undefined, candidates: [] });
        continue;
      }
      const { matches } = await searchStocks(lookup, market, read);
      let canonical: string | undefined;
      try { canonical = stockSymbol(query); } catch { /* Names must match provider results. */ }
      const exact = matches.filter(item => item.symbol === canonical || item.name.toLowerCase() === lookup.toLowerCase());
      const selected = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
      resolutions.push({ query, lookup, status: selected ? 'resolved' : matches.length ? 'ambiguous' : 'not-found',
        symbol: selected?.symbol, candidates: selected ? [selected] : matches.slice(0, 4) });
    } catch {
      resolutions.push({ query, lookup, status: 'unavailable', candidates: [] });
    }
  }
  if (resolutions.every(row => row.status === 'unavailable')) throw new Error('Stock lookup unavailable');
  const symbols = [...new Set(resolutions.flatMap(row => row.symbol ? [row.symbol] : []))];
  const result = symbols.length ? await getStockQuotes(symbols, read) : { quotes: [], unavailableSymbols: [], notice: '尚未唯一确定证券，请核对候选市场与代码。' };
  return { ...result, resolutions };
}

export async function getStockQuotes(symbols: string[], read: PublicDataRead) {
  const url = new URL('https://qt.gtimg.cn/');
  url.search = 'q=' + symbols.join(',');
  const text = await read(url, 'gb18030');
  if (!/v_[a-zA-Z0-9_.-]+="/u.test(text)) throw new Error('Invalid quote response');
  const quotes = parseStockQuotes(text, symbols);
  return { quotes, unavailableSymbols: symbols.filter(symbol => !quotes.some(quote => quote.symbol === symbol)),
    notice: '腾讯财经参考行情，可能延迟；sourceTime为上游报价时间，查询时间不等于成交时间。休市时可能是上一交易日数据。不提供买卖建议。' };
}
