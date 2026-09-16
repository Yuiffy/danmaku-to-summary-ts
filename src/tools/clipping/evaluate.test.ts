import { validateSampleSplits } from './evaluate';
test('evaluation splits by whole session and does not infer negative labels from missing uploads', () => {
    expect(() => validateSampleSplits([{ id: 'a', sessionId: 'one', split: 'screening' },
        { id: 'b', sessionId: 'one', split: 'holdout' }])).toThrow('leakage');
    expect(() => validateSampleSplits([{ id: 'a', sessionId: 'one', split: 'screening' },
        { id: 'b', sessionId: 'two', split: 'holdout' }])).not.toThrow();
});
