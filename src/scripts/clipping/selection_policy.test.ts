export {};
const { resolveSelectionPolicy } = require('./selection_policy');
const own = require('../own_stream_clipper');
const { rankPrompt } = require('./ranked_editorial');
const fs = require('fs'), os = require('os'), path = require('path');
const policy = { excludedCategories: ['global restriction'], roomOverrides: {
  '25788785': { excludedCategories: ['不切家庭关系相关，避免片段引人误解'] }
} };

test('room exclusions are additive, isolated, and included in recall and ranking prompts', () => {
  expect(resolveSelectionPolicy(policy, 25788785).excludedCategories).toHaveLength(2);
  expect(resolveSelectionPolicy(policy, '22470216').excludedCategories).toEqual(['global restriction']);
  expect(resolveSelectionPolicy(policy).excludedCategories).toEqual(['global restriction']);
  expect(policy.excludedCategories).toEqual(['global restriction']);
  const settings = own.getOwnStreamClipsConfig({ ownStreamClips: { selectionPolicy: policy } }, '25788785');
  expect(settings.selectionPolicy.excludedCategories).toHaveLength(2);
  expect(own.buildSelectionPolicyPromptLines(policy, '25788785').join('\n')).toContain('不切家庭关系');
  expect(rankPrompt([], { roomId: '25788785' }, 10, policy)).toContain('不切家庭关系');
  expect(rankPrompt([], { roomId: '22470216' }, 10, policy)).not.toContain('不切家庭关系');
});

test('AI-disabled restricted rooms cannot fall back to local clips', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'room-policy-'));
  const mediaPath = path.join(directory, 'source.flv'), srtPath = path.join(directory, 'source.srt');
  fs.writeFileSync(mediaPath, 'fixture');
  fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:01:00,000\n妈妈和我还在冷战，为什么会这样。\n');
  try {
    await expect(own.generateOwnStreamClips({ mediaPath, srtPath, planOnly: true,
      context: { roomId: '25788785' }, config: { ai: { text: { enabled: false } },
        ownStreamClips: { enabled: true, ai: { enabled: false, fallbackToLocalRules: true }, selectionPolicy: policy }
      } })).rejects.toThrow('已禁用本地回退');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
