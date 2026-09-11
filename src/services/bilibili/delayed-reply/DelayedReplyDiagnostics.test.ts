import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DelayedReplyDiagnostics } from './DelayedReplyDiagnostics';

describe('image rollout operator diagnostics', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-rollout-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('reports model, max quality, tokens and generation duration', () => {
    const image = path.join(directory, 'test.png');
    fs.writeFileSync(path.join(directory, 'test_META.json'), JSON.stringify({
      status: 'success', model: 'gpt-image-2.5-sunburst', quality: 'max', elapsedMs: 125600,
      usage: { input_tokens: 123, output_tokens: 456, input_tokens_details: { image_tokens: 100, text_tokens: 23 } }
    }));
    const info = new DelayedReplyDiagnostics().getComicGenerationInfo(image);
    expect(info).toContain('gpt-image-2.5-sunburst');
    expect(info).toContain('质量: max');
    expect(info).toContain('输入 123，图片 100，文字 23，输出 456 tokens');
    expect(info).toContain('125.6s（含重试）');
  });

  it('distinguishes the selected experiment from fallback and missing usage', () => {
    const image = path.join(directory, 'test.png');
    fs.writeFileSync(path.join(directory, 'test_META.json'), JSON.stringify({
      status: 'failure', model: 'gpt-image-2', quality: 'high', elapsedMs: 5000,
      rolloutVariant: 'gpt-image-2.5-flare:low',
      routeAttempts: [{ model: 'gpt-image-2.5-flare', quality: 'low', status: 'failure', elapsedMs: 1000 }]
    }));
    const info = new DelayedReplyDiagnostics().getComicGenerationInfo(image);
    expect(info).toContain('灰度抽中: gpt-image-2.5-flare:low');
    expect(info).toContain('质量: high');
    expect(info).toContain('用量: 未返回（不可按 0 计）');
    expect(info).toContain('1.0s');
  });
});
