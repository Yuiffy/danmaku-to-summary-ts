const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const material = require('./live_material');
const full = require('./full_live_context');
const combined = require('./full_reply_summary');

describe('shared original material for comics', () => {
  const options = material.getMaterialOptions({ replySummary: { sharedMaterial: { enabled: true } } });
  const segments = Array.from({ length: 240 }, (_, index) => ({ start: index * 20, end: index * 20 + 15,
    text: `[${index % 2 ? 'Host' : 'Guest'} 0.9] ${index}: ${'An original complete line with negation and context. '.repeat(20)}` }));
  const context = full.buildFullLiveSharedContext({ parsed: { segments }, danmaku: [{ time: 20, text: 'Audience reaction' }],
    config: { compactEvidence: true }, info: { roomId: '1' } });
  const payload = full.createFullLiveContextSidecar(context);
  const source = combined.evidenceContext(payload.evidence.speech, [], '1', { ai: { roomSettings: { '1': { anchorName: 'Host' } } } }, payload.evidence);
  const raw = { moments: [3, 70, 135, 225].map(index => ({ sourceIds: ['T' + index], interest: 'A quiet moment' })) };
  const accepted = { evidence: [{ sources: [source.byId.get('T100')], corroboration: [source.byId.get('D1')] }] };

  test('retrieves original context and accepted repair citations without paraphrases', () => {
    const pool = material.buildMaterial(raw, accepted, source, payload, options);
    expect(pool.sourceIds).toContain('T100');
    expect(pool.sourceIds).toContain('D1');
    expect(pool.sourceIds).toContain('T2');
    expect(pool.timeQuarters).toEqual([0, 1, 2, 3]);
    expect(pool.sharedPrefix).toContain('partial original sources');
    expect(pool.sharedPrefix).not.toContain('A quiet moment');
    expect(pool.selectedChars).toBeLessThan(options.maxSourceChars);
  });

  test('rejects unseen citations, narrow coverage and a budget requiring truncation', () => {
    expect(() => material.buildMaterial({ moments: [...raw.moments.slice(0, 3), { sourceIds: ['P1'] }] }, accepted, source, payload, options)).toThrow('source ID');
    expect(() => material.buildMaterial({ moments: [3, 6, 9, 12].map(index => ({ sourceIds: ['T' + index] })) }, accepted, source, payload, options)).toThrow('coverage');
    expect(() => material.buildMaterial(raw, accepted, source, payload, { ...options, maxSourceChars: 20 })).toThrow('budget');
  });

  test('retrieves separate local contexts for distant citations without filling the gap', () => {
    const selected = { moments: [{ sourceIds: ['T3', 'T40'] }, ...raw.moments.slice(1)] };
    const pool = material.buildMaterial(selected, { evidence: [] }, source, payload, options);
    expect(pool.sourceIds).toContain('T3');
    expect(pool.sourceIds).toContain('T40');
    expect(pool.sourceIds).not.toContain('T20');
    expect(pool.sharedPrefix).toContain('Across gaps, do not imply adjacent dialogue');
  });

  test('Python accepts original material and falls back on tampering, changed source or unreviewed state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'material-contract-'));
    const statePath = path.join(dir, 'stream_REPLY_SUMMARY.json');
    const pool = material.buildMaterial(raw, accepted, source, payload, options);
    const state = { status: 'success', roomId: '1', sourceSha256: payload.sourceSha256, semanticReview: { verdict: 'pass' }, sharedMaterial: pool };
    const config = { ai: { roomSettings: { '1': { fullLiveContextExperiment: { enabled: true,
      replySummary: { enabled: true, sharedMaterial: options } } } } } };
    const probe = (saved: any, input = payload) => {
      fs.writeFileSync(statePath, JSON.stringify(saved));
      const result = spawnSync(process.env.PYTHON || 'python', ['-c',
        'import json,sys;sys.path.insert(0,sys.argv[1]);from comic.live_material import select_comic_material;d=json.load(sys.stdin);r=select_comic_material(d["highlight"],"1",d["config"],d["source"],log=lambda *x:None);print(json.dumps({"coverage":r.get("coverage"),"prefix":r["sharedPrefix"]}))', __dirname],
        { input: JSON.stringify({ highlight: path.join(dir, 'stream_AI_HIGHLIGHT.txt'), config, source: input }),
          encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' }, timeout: 10000 });
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    };
    try {
      expect(probe(state)).toEqual({ coverage: 'selected_original_excerpts_with_context', prefix: pool.sharedPrefix });
      expect(probe({ ...state, status: 'outcome_unknown' }).prefix).toBe(payload.sharedPrefix);
      expect(probe({ ...state, sharedMaterial: { ...pool, sourceText: 'Invented fact' } }).prefix).toBe(payload.sharedPrefix);
      expect(probe({ ...state, semanticReview: { verdict: 'reject' } }).prefix).toBe(payload.sharedPrefix);
      expect(probe(state, { ...payload, sourceSha256: 'changed' }).prefix).toBe(payload.sharedPrefix);
      expect(probe({ ...state, roomId: '2' }).prefix).toBe(payload.sharedPrefix);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
