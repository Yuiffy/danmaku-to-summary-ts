export {};
const { renderAndAuditCreative } = require('./creative_media_review');
const initial = { music: { id: 'bgm' }, effects: [{ id: 'M1', sound: { id: 'laugh' } }],
    editorialProfile: { kind: 'story', music: 'playful' }, assetDigests: { bgm: 'music-hash', laugh: 'sound-hash' } };
const failed = { status: 'failed', issues: ['original_audio_changed_outside_effects'] };

test('a rejected music mix is rerendered without music and passes fresh inspection and audio QA', async () => {
    const history = [], render = jest.fn(async plan => ({ media: plan.music ? 'rejected' : 'clean' })), inspect = jest.fn();
    const audit = jest.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce({ status: 'passed', issues: [] });
    const result = await renderAndAuditCreative(initial, { render, inspect, audit, history });
    expect(render).toHaveBeenCalledTimes(2); expect(inspect).toHaveBeenCalledTimes(2); expect(audit).toHaveBeenCalledTimes(2);
    expect(result.rendered.media).toBe('clean'); expect(result.audioQa.status).toBe('passed');
    expect(result.plan.music).toBeUndefined(); expect(result.plan.assetDigests).toEqual({ laugh: 'sound-hash' });
    expect(result.plan.effects).toEqual(initial.effects); expect(initial.music).toEqual({ id: 'bgm' });
    expect(history.filter(row => row.stage === 'audio_technical_qa').map(row => row.result.status)).toEqual(['failed', 'passed']);
});

test('still rejects real dialogue loss after removing music and never retries indefinitely', async () => {
    const render = jest.fn(), audit = jest.fn().mockResolvedValue(failed);
    await expect(renderAndAuditCreative(initial, { render, inspect: jest.fn(), audit, history: [] })).rejects.toThrow('original_audio_changed');
    expect(render).toHaveBeenCalledTimes(2);
});

test('removing the only added audio still requires a fresh original-track audit', async () => {
    const audit = jest.fn().mockResolvedValue(failed);
    await expect(renderAndAuditCreative({ ...initial, effects: [] }, { render: jest.fn(), inspect: jest.fn(), audit, history: [] })).rejects.toThrow('original_audio_changed');
    expect(audit).toHaveBeenCalledTimes(2);
});

test('does not recover missing audio tracks or truncated audio by removing music', async () => {
    const render = jest.fn(), audit = jest.fn();
    await expect(renderAndAuditCreative(initial, { render, inspect: () => { throw new Error('no audio track'); }, audit, history: [] })).rejects.toThrow('no audio track');
    expect(render).toHaveBeenCalledTimes(1); expect(audit).not.toHaveBeenCalled();
    render.mockClear(); audit.mockResolvedValue({ status: 'failed', issues: ['audio_duration_changed'] });
    await expect(renderAndAuditCreative(initial, { render, inspect: jest.fn(), audit, history: [] })).rejects.toThrow('audio_duration_changed');
    expect(render).toHaveBeenCalledTimes(1);
});
