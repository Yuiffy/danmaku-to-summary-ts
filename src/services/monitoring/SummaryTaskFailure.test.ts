import { SummaryFailureDiagnostics, summaryTaskFailureLines } from './SummaryTaskFailure';

const context = {
  taskId: 'original-task', roomId: '25788785', recoveryEpisode: 0,
  mediaPath: 'D:\\files\\25788785_岁己SUI\\2026_10_27\\录制-25788785-20261027-200816-824-陪你这个猪过周二！唱唱聊聊_merged.flv'
};

describe('summary task failure evidence', () => {
  it('explains the recording, true media duration, root cause and stopped dependencies', () => {
    const diagnostics = new SummaryFailureDiagnostics();
    diagnostics.observeOutput('-> [ASR] Generating Subtitles (paraformer)...');
    diagnostics.observeOutput('[[ASR_HANDOFF_STATUS]] {"audio_total_s":17029.726999}');
    diagnostics.observeError('Traceback (most recent call last):\nValueError: Aligned audio ended ');
    diagnostics.observeError('early; checkpoint not advanced\n');
    const details = diagnostics.failure('自动重试耗尽', { ...context, retryCount: 3 });
    expect(details).toMatchObject({ stage: 'asr', durationSeconds: 17029.726999, retryCount: 3 });
    const message = summaryTaskFailureLines(details).join('\n');
    for (const text of ['岁己SUI（25788785）', '2026-10-27 20:08:16（北京时间）',
      '陪你这个猪过周二！唱唱聊聊', '4小时43分50秒', 'ValueError: Aligned audio ended early',
      '累计失败 3 次', '字幕阶段未完成', '自动切片', 'original-task']) expect(message).toContain(text);
    expect(message).not.toContain('本场标题**: 陪你这个猪过周二！唱唱聊聊_merged');
  });

  it.each(['[[ASR_PHASE_DONE]]', '[[WHISPER_PHASE_DONE]]'])('preserves completed subtitles with %s', sentinel => {
    const diagnostics = new SummaryFailureDiagnostics();
    diagnostics.observeOutput(`${sentinel} taskId=original-task`);
    const message = summaryTaskFailureLines(diagnostics.failure('后处理退出', context)).join('\n');
    expect(message).toContain('字幕阶段已完成');
    expect(message).toContain('独立入队的切片可能仍在运行');
    expect(message).not.toContain('字幕阶段未完成');
  });

  it('uses the CLI duration fallback and ignores malformed or invalid duration evidence', () => {
    const diagnostics = new SummaryFailureDiagnostics();
    diagnostics.observeOutput('-> 283:49,726');
    for (const value of ['{bad}', '{"audio_total_s":-1}', '{"audio_total_s":"20"}', '{}']) {
      diagnostics.observeOutput(`[[ASR_HANDOFF_STATUS]] ${value}`);
    }
    expect(diagnostics.failure('failed', context).durationSeconds).toBe(17029.726);
  });

  it('reports unknown duration and refuses to invent a start time from an unrelated filename', () => {
    const details = new SummaryFailureDiagnostics().failure('文件不存在', {
      ...context, mediaPath: '/recordings/other/录制-123-20261027-200816-824-title.flv'
    });
    const message = summaryTaskFailureLines(details).join('\n');
    expect(details.stage).toBe('prepare');
    expect(message).toContain('录播时长**: 未获取');
    expect(message).toContain('录播开始**: 未获取');
    expect(message).not.toContain('2026-10-27 20:08:16');
  });

  it('bounds retained diagnostics and the reason, strips ANSI, and keeps an explicit timeout reason', () => {
    const diagnostics = new SummaryFailureDiagnostics();
    diagnostics.observeError('ValueError: stale\n' + 'x'.repeat(20000) + '\n');
    expect(diagnostics.failure('退出', context).reason).toBe('退出');
    diagnostics.observeError('\u001b[31mRuntimeError: ' + 'y'.repeat(2000) + '\u001b[0m\n');
    const result = diagnostics.failure('退出', context);
    expect(result.reason.length).toBe(1000);
    expect(result.reason).toContain('RuntimeError:');
    expect(result.reason).not.toContain('\u001b');
    expect(diagnostics.failure('超过上限，超时终止', context, false).reason).toBe('超过上限，超时终止');
  });

  it('captures errors logged on stdout and formats platform-independent paths', () => {
    const diagnostics = new SummaryFailureDiagnostics();
    diagnostics.observeOutput('❌ 转写失败: RuntimeError: CUDA out of memory');
    const details = diagnostics.failure('重试耗尽', { ...context, mediaPath: context.mediaPath.replace(/\\/g, '/') });
    const message = summaryTaskFailureLines(details).join('\n');
    expect(message).toContain('CUDA out of memory');
    expect(message).toContain('岁己SUI（25788785）');
  });
});
