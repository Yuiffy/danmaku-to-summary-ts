import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AdminClipStore } from './AdminClipStore';
import { AdminJobs } from './AdminJobs';
import { AdminFeedback } from './AdminFeedback';
import { atomicJson, readJson } from './AdminFiles';
import { isUnchangedReview, parseFeedbackPlan } from './AdminFeedbackPolicy';
import { AdminConfigStore } from './AdminConfigStore';
import { createAdminServer } from './AdminServer';
import { createFeedbackAgent, FeedbackCompletion, FeedbackToolCall } from './AdminFeedbackAgent';

const roots: string[] = [];
function fixture(plan: any = {}, complete?: FeedbackCompletion, directFeedback = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-feedback-')); roots.push(root);
  const assets = path.join(root, 'recordings'); fs.mkdirSync(assets);
  const media = path.join(assets, 'clip.mp4'), cover = path.join(assets, 'cover.jpg'), srt = path.join(assets, 'clip.srt');
  const metadataPath = path.join(assets, 'clip.json'), registryPath = path.join(root, 'data/runtime/clip_upload_registry.json');
  fs.writeFileSync(media, 'media'); fs.writeFileSync(cover, 'cover'); fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\n建功\n');
  atomicJson(metadataPath, { mode: 'own_stream_fun_review', copy: { title: '美甲建构', description: '讨论建构', coverText: '建构不是贱狗' },
    grounding: { sourceKind: 'live_speech' }, output: { mediaPath: media, srtPath: srt, coverPath: cover } });
  atomicJson(registryPath, { clips: { '3354': { id: 3354, title: '美甲建构', description: '讨论建构', status: 'needs_review', reviewPending: true, mediaPath: media,
    coverPath: cover, srtPath: srt, metadataPath, reviewIssues: ['source_window_incomplete'] } } });
  const clips = new AdminClipStore(root, () => [assets]);
  const run = jest.fn(async (command, output) => {
    output(`${command.action} 完成\n`);
    const registry = readJson(registryPath), clip = registry.clips['3354'];
    if (['rebuild', 'cut', 'approve-review'].includes(command.action)) {
      const metadata = readJson(metadataPath);
      for (const [field, flag] of [['title', '--title'], ['description', '--description'], ['coverText', '--cover-text']]) {
        const at = command.args.indexOf(flag);
        if (at >= 0) { metadata.copy[field] = command.args[at + 1]; if (field !== 'coverText') clip[field] = command.args[at + 1]; }
      }
      atomicJson(metadataPath, metadata);
    }
    if (command.action === 'rebuild') clip.pendingRebuild = true;
    if (command.action === 'cut' || command.action === 'approve-review' || command.action === 'automatic-review') { clip.pendingRebuild = false; clip.reviewPending = false; clip.status = 'review'; }
    if (command.action === 'enqueue') {
      clip.status = 'queued';
      atomicJson(path.join(root, 'data/runtime/clip_upload_queue.json'), { jobs: [{ id: 'upload-test', status: 'pending', clipIds: [3354] }] });
    }
    atomicJson(registryPath, registry);
    return 0;
  });
  const jobs = new AdminJobs(path.join(root, 'jobs'), run), planner = jest.fn(async () => JSON.stringify(plan));
  const feedback = new AdminFeedback(clips, jobs, run, planner, complete && createFeedbackAgent(complete), directFeedback);
  const token = 'a'.repeat(64), headers = { Authorization: `Bearer ${token}` };
  const app = createAdminServer({ clips, jobs, feedback, configs: new AdminConfigStore(root) }, token);
  const input = (note = '把“建功”改成“建构”，小岁本人发言，按原窗口制作') => ({ action: 'feedback-publish', note, publishApproved: true, revision: clips.detail('3354').revision });
  return { root, clips, run, jobs, planner, feedback, registryPath, metadataPath, srt, app, headers, input };
}

function songFixture(plan: any = {}) {
  const f = fixture(plan);
  fs.writeFileSync(f.srt, '1\n00:00:00,000 --> 00:00:02,000\n我唱过谢谢吗\n');
  const metadata = readJson(f.metadataPath);
  metadata.type = 'stream_activity_submission'; metadata.source = { srtPath: f.srt };
  metadata.activities = [{ id: 'activity-1', kind: 'song', start: 1, end: 2 }];
  atomicJson(f.metadataPath, metadata); return f;
}

function candidateFixture(plan: any = {}, complete?: FeedbackCompletion) {
  const f = fixture(plan, complete), metadata = readJson(f.metadataPath), registry = readJson(f.registryPath);
  const output = metadata.output;
  delete metadata.grounding;
  Object.assign(metadata, { mode: 'topic_event', status: 'pending_preflight', source: { srtPath: f.srt },
    window: { start: 0, end: 2 }, editorial: { copyGrounding: { sourceKind: 'live_speech' } },
    aiReview: { status: 'needs_review', quality: { issues: ['未找到必要起因或收尾：G2'] },
      boundaryReview: { status: 'needs_review' } }, output: { srtPath: f.srt } });
  Object.assign(registry.clips['3354'], { pendingCut: true, mediaPath: '', coverPath: '', reviewPending: false, reviewIssues: [], status: 'pending_cut' });
  atomicJson(f.metadataPath, metadata); atomicJson(f.registryPath, registry);
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (command, write) => {
    const code = await original(command, write);
    if (command.action === 'cut') {
      const rendered = readJson(f.metadataPath), latest = readJson(f.registryPath);
      rendered.output = output;
      Object.assign(latest.clips['3354'], { pendingCut: false, mediaPath: output.mediaPath, coverPath: output.coverPath });
      atomicJson(f.metadataPath, rendered); atomicJson(f.registryPath, latest);
    }
    return code;
  });
  return f;
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('returns the persisted boundary recovery failure to the editor after a failed candidate cut', async () => {
  const f = candidateFixture();
  f.run.mockImplementation(async (command, output) => {
    output('cut failed\n');
    const metadata = readJson(f.metadataPath);
    metadata.candidateRecovery = { status: 'failed', error: '收尾仍在原始ASR段内：G3 / R2',
      original: { privateSourcePath: 'not-for-editor' } };
    atomicJson(f.metadataPath, metadata);
    return 2;
  });
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed',
    output: expect.stringContaining('收尾仍在原始ASR段内：G3 / R2') });
  expect(f.clips.feedbackDetail('3354').evidence.candidateRecovery).toEqual({
    status: 'failed', error: '收尾仍在原始ASR段内：G3 / R2' });
  expect(f.run).toHaveBeenCalledTimes(1);
});

const agentCall = (name: string, args: unknown = {}) => ({ content: null, tool_calls: [{ id: `call_${name}`,
  type: 'function', function: { name, arguments: JSON.stringify(args) } } as FeedbackToolCall] });

it('uses explicit feedback acceptance for an existing video without rerendering or asking AI to approve it', async () => {
  const f = fixture({}, undefined, true);
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['approve-review', 'enqueue']);
  expect(f.run.mock.calls[0][0].args).toContain('--feedback-authorized');
  expect(f.run.mock.calls.flatMap(([command]) => command.args)).not.toContain('--automatic-review');
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('succeeded');
  expect(f.planner).not.toHaveBeenCalled();
});

it.each(['planner', 'agent'])('prepares missing public copy before a bare publish request using the %s', async mode => {
  const plan = { description: '讨论美甲建构', coverText: '美甲建构' };
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockImplementationOnce(async messages => {
      expect(messages[0].content).toContain('缺失文案须根据当前片内证据补齐，保留已有标题和范围');
      return agentCall('inspect_clip');
    })
    .mockResolvedValueOnce(agentCall('revise_and_review', { plan }))
    .mockResolvedValueOnce(agentCall('enqueue_submission'));
  const f = fixture(plan, mode === 'agent' ? complete : undefined, true);
  const metadata = readJson(f.metadataPath), registry = readJson(f.registryPath);
  metadata.copy.description = ''; metadata.copy.coverText = '';
  registry.clips['3354'].description = '';
  atomicJson(f.metadataPath, metadata); atomicJson(f.registryPath, registry);
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'enqueue']);
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining([
    '--title', '美甲建构', '--description', plan.description, '--cover-text', plan.coverText, '--feedback-authorized'
  ]));
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'succeeded', note: '投', plan });
  expect(f.clips.detail('3354').title).toBe('美甲建构');
  if (mode === 'agent') expect(complete).toHaveBeenCalledTimes(3);
  else expect(f.planner).toHaveBeenCalledTimes(1);
});

it('uses directly supplied missing copy without model planning for a bare publish request', async () => {
  const f = fixture({}, undefined, true), metadata = readJson(f.metadataPath), registry = readJson(f.registryPath);
  metadata.copy.description = ''; metadata.copy.coverText = ''; registry.clips['3354'].description = '';
  atomicJson(f.metadataPath, metadata); atomicJson(f.registryPath, registry);
  f.feedback.submit('3354', { ...f.input('投'), description: '讨论美甲建构', coverText: '美甲建构' });
  await f.jobs.flush();
  expect(f.planner).not.toHaveBeenCalled();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'enqueue']);
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('succeeded');
});

it('applies the requested changes before feedback-authorized rendering and enqueues without AI gating', async () => {
  const f = fixture({ title: '用户指定的新标题', corrections: [{ from: '建功', to: '建构' }] }, undefined, true);
  f.feedback.submit('3354', f.input()); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'correct', 'cut', 'enqueue']);
  for (const [command] of f.run.mock.calls.filter(([command]) => ['rebuild', 'cut'].includes(command.action))) {
    expect(command.args).toContain('--feedback-authorized');
    expect(command.args).not.toContain('--automatic-review');
  }
  expect(f.clips.detail('3354').title).toBe('用户指定的新标题');
});

it('does not enqueue after feedback-authorized media creation fails', async () => {
  const f = fixture({ title: '用户指定标题', corrections: [{ from: '建功', to: '建构' }] }, undefined, true), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (command, output) => command.action === 'cut' ? 2 : original(command, output));
  f.feedback.submit('3354', f.input()); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'correct', 'cut']);
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('failed');
});

it('applies an explicit title to an existing highlight-first video without rebuilding its source window', async () => {
  const f = fixture({}, undefined, true), metadata = readJson(f.metadataPath);
  metadata.editorialStyle = { selected: 'highlight_first', status: 'completed' };
  metadata.window = { start: 10, end: 12, duration: 5.2 };
  atomicJson(f.metadataPath, metadata);
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (command, output) => {
    if (command.action === 'rebuild') { output('Clip subtitles exceed the source window'); return 2; }
    return original(command, output);
  });
  f.feedback.submit('3354', { ...f.input('投'), title: '用户手写的新标题' }); await f.jobs.flush();
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('succeeded');
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['approve-review', 'enqueue']);
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--title', '用户手写的新标题', '--feedback-authorized']));
  expect(f.clips.detail('3354').title).toBe('用户手写的新标题');
  expect(readJson(f.metadataPath).window.duration).toBe(5.2);
});

it('recovers source context for a rejected candidate whose formal window was lost', async () => {
  const f = fixture({}, undefined, true), metadata = readJson(f.metadataPath);
  metadata.selectionRejection = { reason: 'missing_selected_candidate_detail' };
  metadata.window = { start: null, end: null };
  metadata.reviewPresentation = { window: { start: 0, end: 2 } };
  metadata.source = { srtPath: f.srt };
  atomicJson(f.metadataPath, metadata);
  const context = f.clips.feedbackDetail('3354');
  expect(context.source.subtitles).toContain('建功');
  expect(context.evidence.recallWindow).toEqual({ start: 0, end: 2 });
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--replan', '--start', '0', '--end', '2', '--feedback-authorized']));
});

it('continues a feedback retry when its exact replacement is already saved across subtitle cues', async () => {
  const f = fixture({ corrections: [{ from: '人脸萌', to: '冷脸萌' }] }, undefined, true), metadata = readJson(f.metadataPath);
  metadata.renderedSubtitles = { cues: [{ text: '像冷脸' }, { text: '萌' }] };
  atomicJson(f.metadataPath, metadata);
  f.feedback.submit('3354', f.input('“人脸萌”应该为“冷脸萌”')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'enqueue']);
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('succeeded');
});

it('executes every confirmed name variant through literal correct commands before rendering and enqueueing', async () => {
  const corrections = ['石手心汤', '石手心肠', '石手先生'].map(from => ({ from, to: '时守星沙' }));
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockImplementationOnce(async messages => {
      expect(messages[0].content).toContain(JSON.stringify(corrections));
      return agentCall('inspect_clip');
    }).mockResolvedValueOnce(agentCall('revise_and_review', { plan: { corrections: [corrections[0]] } }))
    .mockImplementationOnce(async messages => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ ready: true });
      return agentCall('enqueue_submission');
    });
  const f = fixture({}, complete, true);
  fs.writeFileSync(f.srt, `1\n00:00:00,000 --> 00:00:02,000\n石手心汤 石手心汤 石手心肠 石手先生\n`);
  f.feedback.submit('3354', f.input('里面的“石手xx”都是时守星沙。')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'correct', 'correct', 'correct', 'cut', 'enqueue']);
  const commands = f.run.mock.calls.map(([command]) => command).filter(command => command.action === 'correct');
  commands.forEach((command, index) => {
    expect(command.args).toEqual(expect.arrayContaining(['--from', corrections[index].from, '--to', '时守星沙']));
    expect(command.args).not.toContain('--cue');
  });
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'succeeded', plan: { corrections } });
});

it('returns fresh review reasons and cited human checks so the editor can repair copy before enqueue', async () => {
  const reason = '标题中的人物称呼缺乏片内证据，可省略人名保留请化妆师的事件';
  const humanChecks = [{ question: '这个称呼是否确实是某人？', cueIds: ['G2'],
    evidence: [{ id: 'G2', start: 1, end: 2, text: '今天找了化妆师' }] }];
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockResolvedValueOnce(agentCall('inspect_clip'))
    .mockResolvedValueOnce(agentCall('revise_and_review', { plan: { title: '某人请了化妆师' } }))
    .mockImplementationOnce(async messages => {
      const result = JSON.parse(messages.at(-1)!.content!);
      expect(result).toMatchObject({ ready: false, review: { attribution: ['model_requires_review'] },
        reviewDetails: { attribution: { status: 'needs_review', reason, humanChecks },
          publication: { status: 'needs_review', issues: ['attribution_not_passed'] } } });
      expect(JSON.stringify(result)).not.toContain('privateSourcePath');
      return agentCall('revise_and_review', { plan: { title: '请化妆师，只因要见很多人' } });
    }).mockResolvedValueOnce(agentCall('enqueue_submission'));
  const f = fixture({}, complete), original = f.run.getMockImplementation()!;
  let cuts = 0;
  f.run.mockImplementation(async (command, output) => {
    const code = await original(command, output);
    if (command.action === 'cut') {
      const metadata = readJson(f.metadataPath), registry = readJson(f.registryPath);
      const first = ++cuts === 1;
      metadata.attributionReview = first ? { status: 'needs_review', reason, humanChecks,
        issues: ['model_requires_review'], history: [{ privateSourcePath: 'not-for-editor' }] }
        : { status: 'passed', reason: '文案已有片内支持', issues: [], humanChecks: [] };
      metadata.publicationReview = { status: first ? 'needs_review' : 'passed', issues: first ? ['attribution_not_passed'] : [] };
      registry.clips['3354'].reviewPending = first;
      atomicJson(f.metadataPath, metadata); atomicJson(f.registryPath, registry);
    }
    return code;
  });
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'rebuild', 'cut', 'enqueue']);
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('succeeded');
});

it('runs an actual inspect/edit/review/enqueue tool conversation and observes the resulting title', async () => {
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockResolvedValueOnce(agentCall('inspect_clip'))
    .mockResolvedValueOnce(agentCall('revise_and_review', { plan: { title: '小岁解释美甲建构的发音' } }))
    .mockImplementationOnce(async messages => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ title: '小岁解释美甲建构的发音', ready: true });
      return agentCall('enqueue_submission');
    });
  const f = fixture({}, complete);
  f.feedback.submit('3354', f.input('标题大意改为小岁解释美甲建构的发音')); await f.jobs.flush();
  expect(f.planner).not.toHaveBeenCalled();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'succeeded' });
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'enqueue']);
  expect(f.clips.detail('3354').title).toBe('小岁解释美甲建构的发音');
});

it('reports a title lost during rendering to the agent, which repairs it before enqueue', async () => {
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockResolvedValueOnce(agentCall('inspect_clip'))
    .mockResolvedValueOnce(agentCall('revise_and_review', { plan: { title: '用户想要的看点' } }))
    .mockImplementationOnce(async messages => {
      const result = JSON.parse(messages.at(-1)!.content!);
      expect(result).toMatchObject({ title: '复核模型擅改标题', requestedTitle: '用户想要的看点', ready: false });
      expect(result.issues.join('')).toContain('没有保留');
      return agentCall('revise_and_review', { plan: { title: '用户想要的看点' } });
    }).mockResolvedValueOnce(agentCall('enqueue_submission'));
  const f = fixture({}, complete), original = f.run.getMockImplementation()!;
  let cutCount = 0;
  f.run.mockImplementation(async (command, output) => {
    const code = await original(command, output);
    if (command.action === 'cut' && ++cutCount === 1) {
      const registry = readJson(f.registryPath); registry.clips['3354'].title = '复核模型擅改标题'; atomicJson(f.registryPath, registry);
    }
    return code;
  });
  f.feedback.submit('3354', f.input('标题按我的看点改')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'rebuild', 'cut', 'enqueue']);
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('succeeded');
});

it('does not let an agent enqueue without current review or replace a direct title edit', async () => {
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockResolvedValueOnce(agentCall('inspect_clip'))
    .mockResolvedValueOnce(agentCall('enqueue_submission'))
    .mockImplementationOnce(async messages => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ ok: false, error: expect.stringContaining('尚未通过') });
      return agentCall('revise_and_review', { plan: { title: '模型另拟标题' } });
    }).mockResolvedValueOnce(agentCall('enqueue_submission'));
  const f = fixture({}, complete);
  f.feedback.submit('3354', { ...f.input('按这个标题投稿'), title: '我直接填写的标题' }); await f.jobs.flush();
  expect(f.clips.detail('3354').title).toBe('我直接填写的标题');
  expect(f.run.mock.calls.filter(([command]) => command.action === 'enqueue')).toHaveLength(1);
});

it('rejects agent target overrides and stops on source changes while the agent is deciding', async () => {
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockResolvedValueOnce(agentCall('inspect_clip'))
    .mockResolvedValueOnce(agentCall('enqueue_submission', { id: '9999', publishApproved: true }))
    .mockImplementationOnce(async messages => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ ok: false, error: expect.stringContaining('未知') });
      fs.writeFileSync(f.srt, 'changed source');
      return agentCall('revise_and_review', { plan: { title: '新标题' } });
    });
  const f = fixture({}, complete);
  f.feedback.submit('3354', f.input()); await f.jobs.flush();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', output: expect.stringContaining('外部修改') });
});

it('repairs song boundaries through the fixed source CLI, then reviews before enqueue', async () => {
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockResolvedValueOnce(agentCall('inspect_clip'))
    .mockResolvedValueOnce(agentCall('repair_activity_boundaries', { reviewPrelude: true }))
    .mockResolvedValueOnce(agentCall('revise_and_review', { plan: {} }))
    .mockResolvedValueOnce(agentCall('enqueue_submission'));
  const f = fixture({}, complete), metadata = readJson(f.metadataPath);
  Object.assign(metadata, { type: 'stream_activity_submission', kind: 'songs',
    source: { mediaPath: metadata.output.mediaPath, srtPath: f.srt }, activities: [{ id: 'a', kind: 'song', start: 0, end: 2 }] });
  atomicJson(f.metadataPath, metadata);
  f.feedback.submit('3354', f.input('保留两首，修复第二首混入试听的边界再投稿')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['retry-boundaries', 'automatic-review', 'enqueue']);
  expect(f.run.mock.calls[0][0]).toMatchObject({ reviewOnly: true, target: '3354' });
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--media', metadata.output.mediaPath, '--review-prelude']));
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('succeeded');
});

it('reads rendered copy without sending an empty coverText to human review', () => {
  const f = fixture();
  expect(f.clips.detail('3354')).toMatchObject({ title: '美甲建构', description: '讨论建构', coverText: '建构不是贱狗' });
});

it('forwards direct feedback publication acceptance to the dedicated activity CLI', async () => {
  const f = fixture({}, undefined, true), metadata = readJson(f.metadataPath);
  Object.assign(metadata, { type: 'stream_activity_submission', kind: 'songs',
    source: { mediaPath: metadata.output.mediaPath, srtPath: f.srt },
    activities: [{ id: 'activity-1', kind: 'song', start: 0, end: 2 }] });
  atomicJson(f.metadataPath, metadata);
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['approve-review', 'enqueue']);
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['approve', '--feedback-authorized', '--note', '投']));
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('succeeded');
  expect(f.planner).not.toHaveBeenCalled();
});

it('treats a short publication request as automatic review and keeps old holds for the final checker', async () => {
  const f = fixture({ title: '看卡在垃圾桶的视频，猜拍前约好了', description: '讨论视频是否提前安排' });
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.planner).toHaveBeenCalledTimes(1);
  expect(f.planner.mock.calls[0][0]).toContain('不是阻止开始修改的理由');
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'enqueue']);
  expect(f.run.mock.calls[1][0].args).toContain('--automatic-review');
  expect(f.jobs.latest('feedback-publish', '3354')?.plan).not.toHaveProperty('reviewMode', 'human');
});

it('publishes a held keyword candidate through cut and independent review using its editorial source kind', async () => {
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockImplementationOnce(async (_messages, tools) => {
      expect(tools.map(item => item.function.name)).not.toEqual(expect.arrayContaining(['repair_activity_boundaries']));
      expect(tools.map(item => item.function.name)).not.toContain('identify_song_names');
      return agentCall('inspect_clip');
    }).mockImplementationOnce(async messages => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ pendingCut: true, sourceKind: 'live_speech',
        review: { preflight: { status: 'needs_review', boundaryReview: { status: 'needs_review' } } } });
      return agentCall('revise_and_review', { plan: { sourceKind: 'live_speech' } });
    }).mockImplementationOnce(async messages => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ pendingCut: false, ready: true });
      return agentCall('enqueue_submission');
    });
  const f = candidateFixture({}, complete);
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['cut', 'enqueue']);
  expect(f.run.mock.calls[0][0].args).toContain('--automatic-review');
  expect(f.run.mock.calls[0][0].args).not.toContain('--source-kind');
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'succeeded', note: '投' });
  expect(readJson(path.join(f.root, 'data/runtime/clip_upload_queue.json')).jobs[0].clipIds).toEqual([3354]);
});

it('allows missing candidate attribution to reach existing preflight without inventing a source kind', async () => {
  const f = candidateFixture(), metadata = readJson(f.metadataPath);
  delete metadata.editorial.copyGrounding; atomicJson(f.metadataPath, metadata);
  f.run.mockImplementation(async (command, output) => {
    expect(command.action).toBe('cut'); output('Boundary recovery still needs review'); return 2;
  });
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.planner).toHaveBeenCalledTimes(1);
  expect(f.planner.mock.calls[0][0]).toContain('"clip":{"pendingCut":true}');
  expect(f.planner.mock.calls[0][0]).toContain('未找到必要起因或收尾：G2');
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['cut']);
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed',
    output: expect.stringContaining('Boundary recovery still needs review') });
  expect(readJson(f.metadataPath).humanReview).toBeUndefined();
});

it.each([{ sourceKind: 'recount' }])('holds unsupported candidate edits %j before invoking cut', async plan => {
  const f = candidateFixture(plan);
  f.feedback.submit('3354', f.input('按意见修改后投')); await f.jobs.flush();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', output: expect.stringContaining('归属修改') });
});

it('routes a requested pending candidate extension through replan and independent cut before enqueue', async () => {
  const f = candidateFixture({ start: 0, end: 3 });
  fs.writeFileSync(f.srt, '1\n00:00:00,000 --> 00:00:02,000\n建功\n\n2\n00:00:02,000 --> 00:00:03,000\n完整收尾\n');
  f.feedback.submit('3354', f.input('收尾多保留一秒再投')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'enqueue']);
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--replan', '--start', '0', '--end', '3']));
  expect(f.run.mock.calls[1][0].args).toContain('--automatic-review');
  expect(f.run.mock.calls.some(([command]) => command.action === 'approve-review')).toBe(false);
});

it('does not enqueue a keyword candidate when cut exits successfully but final review still holds it', async () => {
  const f = candidateFixture(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (command, output) => {
    const code = await original(command, output);
    const registry = readJson(f.registryPath);
    registry.clips['3354'].reviewPending = true;
    registry.clips['3354'].reviewIssues = ['topic_boundary_incomplete']; atomicJson(f.registryPath, registry);
    return code;
  });
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['cut']);
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', output: expect.stringContaining('topic_boundary_incomplete') });
});

it('rejects an activity-only tool called by a keyword candidate agent without running a command', async () => {
  const complete = jest.fn<ReturnType<FeedbackCompletion>, Parameters<FeedbackCompletion>>()
    .mockResolvedValueOnce(agentCall('inspect_clip'))
    .mockResolvedValueOnce(agentCall('repair_activity_boundaries', { reviewAudio: true }))
    .mockImplementationOnce(async messages => {
      expect(JSON.parse(messages.at(-1)!.content!)).toMatchObject({ ok: false, error: '此切片不支持的编辑工具' });
      return agentCall('report_blocked', { reason: '停止不适用的活动修复' });
    });
  const f = candidateFixture({}, complete);
  f.feedback.submit('3354', f.input('投')); await f.jobs.flush();
  expect(f.run).not.toHaveBeenCalled();
});

it('uses per-clip duration approval when a complete long or short event needs a copy revision', async () => {
  const f = fixture({ durationNote: '保留观看片段及完整点评，避免截掉结尾' });
  f.feedback.submit('3354', f.input('标题大意改为 看视频说你很可爱')); await f.jobs.flush();
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--allow-long', '--allow-short', '--duration-note', '保留观看片段及完整点评，避免截掉结尾']));
});

it('replans a recoverable rejected candidate using the new evidence-bound window and original ID', async () => {
  const f = fixture({ start: 1, end: 3, sourceKind: 'recount', title: '食品级是谁吃', description: '讲到食品级的问答', coverText: '食品级\n谁吃？' });
  const metadata = readJson(f.metadataPath); metadata.source = { srtPath: f.srt }; metadata.window = { start: 0, end: 2 };
  metadata.selectionRejection = { reason: 'detail_generation_failed' }; atomicJson(f.metadataPath, metadata);
  fs.writeFileSync(f.srt, '1\n00:00:00,000 --> 00:00:04,000\n食品级是谁吃\n');
  f.feedback.submit('3354', f.input('投，大意是食品级是谁吃')); await f.jobs.flush();
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--replan', '--id', '3354', '--start', '1', '--end', '3']));
});

it('repairs an incomplete rejected-candidate plan once before any modification and preserves the saved intent', async () => {
  const f = fixture({ title: '食品级是谁吃', description: '转述食品级的问答', coverText: '食品级\n谁吃？' });
  const metadata = readJson(f.metadataPath); delete metadata.grounding;
  metadata.source = { srtPath: f.srt }; metadata.window = { start: 0, end: 2 };
  metadata.selectionRejection = { reason: 'detail_generation_failed' }; atomicJson(f.metadataPath, metadata);
  fs.writeFileSync(f.srt, '1\n00:00:00,000 --> 00:00:04,000\n食品级是谁吃\n');
  f.planner.mockImplementationOnce(async () => {
    expect(f.run).not.toHaveBeenCalled();
    return JSON.stringify({ title: '食品级是谁吃', description: '转述食品级的问答', coverText: '食品级\n谁吃？' });
  }).mockImplementationOnce(async prompt => {
    expect(f.run).not.toHaveBeenCalled();
    expect(prompt).toContain('sourceKind'); expect(prompt).toContain('start/end');
    expect(prompt).toContain('上一份计划');
    return JSON.stringify({ sourceKind: 'recount', start: 1, end: 3 });
  });
  const input = { ...f.input('投，大意是小岁说食品级，小栞问谁吃'), title: '用户确认的标题' };
  f.feedback.submit('3354', input); await f.jobs.flush();
  expect(f.planner).toHaveBeenCalledTimes(2);
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut', 'enqueue']);
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--replan', '--source-kind', 'recount', '--start', '1', '--end', '3', '--title', input.title]));
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'succeeded', note: input.note, edits: { title: input.title } });
});

it('stops an incomplete plan after the bounded repair without rendering or enqueueing', async () => {
  const f = fixture(), metadata = readJson(f.metadataPath); delete metadata.grounding;
  atomicJson(f.metadataPath, metadata);
  const input = f.input('投'); f.feedback.submit('3354', input); await f.jobs.flush();
  expect(f.planner).toHaveBeenCalledTimes(2); expect(f.run).not.toHaveBeenCalled();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', note: input.note,
    output: expect.stringContaining('修改计划缺少') });
});

it('repairs an invented verbatim quote from a topic paraphrase before preparing the revision', async () => {
  const f = fixture({ description: '转述食品级的问答，小栞问“谁吃？”' });
  fs.writeFileSync(f.srt, '1\n00:00:00,000 --> 00:00:02,000\n然后他说谁要吃\n');
  const metadata = readJson(f.metadataPath); metadata.source = { srtPath: f.srt }; metadata.window = { start: 0, end: 2 };
  atomicJson(f.metadataPath, metadata);
  f.planner.mockResolvedValueOnce(JSON.stringify({ description: '转述食品级的问答，小栞问“谁吃？”' }))
    .mockImplementationOnce(async prompt => {
      expect(f.run).not.toHaveBeenCalled(); expect(prompt).toContain('缺少原文逐字支持');
      return JSON.stringify({ description: '转述食品级的问答，对方问谁要吃' });
    });
  const input = f.input('投，大意是小栞问谁吃');
  f.feedback.submit('3354', input); await f.jobs.flush();
  expect(f.planner).toHaveBeenCalledTimes(2);
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--description', '转述食品级的问答，对方问谁要吃']));
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'succeeded', note: input.note });
});

it('holds a candidate changed during the plan repair and never continues with stale evidence', async () => {
  const f = fixture(), metadata = readJson(f.metadataPath); delete metadata.grounding;
  atomicJson(f.metadataPath, metadata);
  f.planner.mockResolvedValueOnce('{}').mockImplementationOnce(async () => {
    fs.appendFileSync(f.srt, '\n新的原话'); return JSON.stringify({ sourceKind: 'playback' });
  });
  f.feedback.submit('3354', f.input('看视频，标题改为很可爱')); await f.jobs.flush();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', output: expect.stringContaining('已变化') });
});

it('limits multipart activity feedback to each activity context while preserving absolute source indices', () => {
  const f = fixture(), metadata = readJson(f.metadataPath);
  fs.writeFileSync(f.srt, '1\n00:00:10,000 --> 00:00:12,000\n第一首前文\n\n'
    + '2\n01:00:00,000 --> 01:00:02,000\n' + '无关聊天'.repeat(40000) + '\n\n'
    + '3\n02:00:00,000 --> 02:00:02,000\n第二首前文\n');
  metadata.type = 'stream_activity_submission'; metadata.source = { srtPath: f.srt };
  metadata.activities = [{ id: 'song-1', start: 10, end: 20 }, { id: 'song-2', start: 7200, end: 7210 }];
  atomicJson(f.metadataPath, metadata);
  const registry = readJson(f.registryPath); registry.clips['3354'].srtPath = '';
  registry.clips['3354'].start = '00:00:10'; registry.clips['3354'].duration = '02:00:00';
  atomicJson(f.registryPath, registry);
  const detail = f.clips.feedbackDetail('3354');
  expect(detail.source.subtitles).toContain('第一首前文');
  expect(detail.source.subtitles).toContain('3\n02:00:00,000');
  expect(detail.source.subtitles).not.toContain('无关聊天');
  expect(detail.evidence.titleContext.map((row: any) => row.index)).toEqual([1, 3]);
});

it('binds a reviewed song name to its source activity and restyles the existing bundle before approval', async () => {
  const f = fixture({ activityTitles: [{ activityId: 'activity-1', name: '屑屑', sourceAlias: '谢谢', segmentIndices: [1], note: '用户确认此首歌曲名称' }] });
  fs.writeFileSync(f.srt, '1\n00:00:00,000 --> 00:00:02,000\n我唱过谢谢吗\n');
  const metadata = readJson(f.metadataPath); metadata.type = 'stream_activity_submission'; metadata.source = { srtPath: f.srt };
  metadata.activities = [{ id: 'activity-1', kind: 'song', start: 1, end: 2 }]; atomicJson(f.metadataPath, metadata);
  f.feedback.submit('3354', f.input('歌曲是 Chillchill 的屑屑')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['restyle', 'automatic-review', 'enqueue']);
  const args = f.run.mock.calls[0][0].args, inputFile = args[args.indexOf('--title-evidence') + 1];
  expect(readJson(inputFile)).toMatchObject({ items: [{ activityId: 'activity-1', name: '屑屑', segmentIndices: [1] }] });
  const detail = f.clips.feedbackDetail('3354');
  expect(() => parseFeedbackPlan(JSON.stringify({ activityTitles: [{ activityId: 'activity-2', name: '屑屑', sourceAlias: '谢谢', segmentIndices: [1], note: '别的歌' }] }), detail, '屑屑')).toThrow('本活动');
  expect(() => parseFeedbackPlan(JSON.stringify({ activityTitles: [{ activityId: 'activity-1', name: '屑屑', sourceAlias: '谢谢', segmentIndices: [2], note: '不存在原文' }] }), detail, '屑屑')).toThrow('本活动');
});

it('repairs an invalid activity name citation once before any mutation using the same source evidence', async () => {
  const item = { activityId: 'activity-1', name: '屑屑', sourceAlias: '谢谢', segmentIndices: [1], note: '用户确认歌名' };
  const f = songFixture({ activityTitles: [item] });
  f.planner.mockResolvedValueOnce(JSON.stringify({ activityTitles: [{ ...item, sourceAlias: '屑屑' }] }));
  f.feedback.submit('3354', f.input('歌曲是 Chillchill 的屑屑')); await f.jobs.flush();
  expect(f.planner).toHaveBeenCalledTimes(2);
  expect(f.planner.mock.calls[1][0]).toContain('上一份名称计划未执行');
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['restyle', 'automatic-review', 'enqueue']);
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'succeeded', note: '歌曲是 Chillchill 的屑屑' });
});

it('keeps an invalid second activity name plan pending without falling back to approving the old name', async () => {
  const f = songFixture({ activityTitles: [{ activityId: 'activity-1', name: '屑屑', sourceAlias: '屑屑',
    segmentIndices: [1], note: '没有原文支持' }] });
  f.feedback.submit('3354', f.input('歌曲是 Chillchill 的屑屑')); await f.jobs.flush();
  expect(f.planner).toHaveBeenCalledTimes(2); expect(f.run).not.toHaveBeenCalled();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', note: '歌曲是 Chillchill 的屑屑',
    output: expect.stringContaining('活动名称需绑定本活动附近原文及用户确认') });
});

it('supplies saved activity title citations to planning but still requires the dedicated boundary review', async () => {
  const f = songFixture();
  const metadata = readJson(f.metadataPath);
  metadata.presentation = { titleEvidence: { version: 1, items: [{ activityId: 'activity-1', name: '屑屑',
    sourceAlias: '谢谢', segments: [{ index: 1, text: '我唱过谢谢吗' }], note: '用户确认歌名' }] } };
  atomicJson(f.metadataPath, metadata);
  f.planner.mockImplementationOnce(async prompt => {
    const evidence = JSON.parse(prompt.split('当前切片和证据：')[1]).evidence;
    expect(evidence.existingActivityTitles).toEqual([expect.objectContaining({ activityId: 'activity-1',
      name: '屑屑', sourceAlias: '谢谢', segmentIndices: [1] })]);
    return '{}';
  });
  f.run.mockImplementation(async (_command, output) => { output('song performance or complete boundaries are unresolved'); return 2; });
  f.feedback.submit('3354', f.input('歌曲是 Chillchill 的屑屑')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['automatic-review']);
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', phase: '正在核验完整投稿包',
    note: '歌曲是 Chillchill 的屑屑', output: expect.stringContaining('complete boundaries are unresolved') });
});

it('preserves the media version when review or queue status changes, but updates it for changed subtitles', () => {
  const f = fixture(), before = f.clips.detail('3354'), registry = readJson(f.registryPath);
  registry.clips['3354'].status = 'queued'; atomicJson(f.registryPath, registry);
  const queued = f.clips.detail('3354');
  expect(queued.revision).not.toBe(before.revision);
  expect(queued.mediaRevision).toBe(before.mediaRevision);
  expect(queued.sourceRevision).toBe(before.sourceRevision);
  fs.writeFileSync(f.srt, '1\n00:00:00,000 --> 00:00:02,000\n建构\n');
  expect(f.clips.detail('3354').mediaRevision).not.toBe(before.mediaRevision);
});

it('treats an explicit unchanged review as human approval and enqueues despite an old automatic-review hold', async () => {
  const f = fixture({ blockedReason: '当前录播证据窗口不完整，无法完成审核投稿。' });
  f.feedback.submit('3354', f.input('核对无误')); await f.jobs.flush();
  expect(f.planner).not.toHaveBeenCalled();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['approve-review', 'enqueue']);
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--review-note', '核对无误', '--cover-text', '建构不是贱狗', '--source-kind', 'live_speech']));
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'succeeded', phase: '已加入投稿队列' });
});

it('keeps a failed human approval visible and does not enqueue', async () => {
  const f = fixture();
  f.run.mockImplementationOnce(async (_command, output) => { output('Original subtitle evidence changed'); return 2; });
  f.feedback.submit('3354', f.input('已核对无误，无需修改')); await f.jobs.flush();
  expect(f.planner).not.toHaveBeenCalled();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['approve-review']);
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', output: expect.stringContaining('Original subtitle evidence changed') });
});

it('does not approve an old video when an unchanged review has a pending subtitle revision', async () => {
  const f = fixture(), registry = readJson(f.registryPath);
  registry.clips['3354'].pendingRebuild = true; atomicJson(f.registryPath, registry);
  f.feedback.submit('3354', f.input('核对无误')); await f.jobs.flush();
  expect(f.planner).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', output: expect.stringContaining('待制作修订') });
});

it.each(['核对无误', '已核对无误，无需修改。', '无需修改，核对无误，直接投稿', '已经核对所有内容，按现有文案制作并投稿', '所有P的原音和边界已核对，无需修改'])('recognizes a complete unchanged confirmation: %s', note => {
  expect(isUnchangedReview(note)).toBe(true);
});

it.each(['核对无误，但边界还要改', '没有核对无误', '核对无误？', '把“核对无误”改成“有问题”', '核对无误，字幕“建功”改成“建构”', '无需修改'])('does not treat a partial, quoted, or uncertain confirmation as unchanged: %s', note => {
  expect(isUnchangedReview(note)).toBe(false);
});

it('requires the registry to become ready even after a human-review command exits successfully', async () => {
  const f = fixture();
  f.run.mockImplementation(async (_command, output) => { output('review still pending'); return 0; });
  f.feedback.submit('3354', f.input('核对无误')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['approve-review']);
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', output: expect.stringContaining('复核尚未通过') });
});

it('saves the opinion before planning, applies changes, independently reviews, and enqueues once under the same ID', async () => {
  const f = fixture({ corrections: [{ from: '建功', to: '建构', cue: 1 }], title: '改后的标题' });
  let release!: () => void;
  f.planner.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(JSON.stringify({ corrections: [{ from: '建功', to: '建构', cue: 1 }] })); }));
  const input = f.input();
  const submitted = await request(f.app).post('/clips/3354/actions').set(f.headers).send(input).expect(202);
  const saved = readJson(path.join(f.root, 'jobs', `${submitted.body.id}.json`));
  expect(saved).toMatchObject({ note: input.note, revision: input.revision, status: 'running' });
  const duplicate = await request(f.app).post('/clips/3354/actions').set(f.headers).send(input).expect(202);
  expect(duplicate.body.id).toBe(submitted.body.id); expect(f.planner).toHaveBeenCalledTimes(1);
  await request(f.app).post('/clips/3354/actions').set(f.headers).send({ ...input, note: '新意见' }).expect(409);
  release(); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'correct', 'cut', 'enqueue']);
  const commands = f.run.mock.calls.map(([command]) => command);
  expect(commands[0].args).toEqual(expect.arrayContaining(['--cover-text', '建构不是贱狗', '--source-kind', 'live_speech']));
  expect(commands[2].args).toContain('--automatic-review');
  expect(commands.slice(0, 3).some(command => command.args.includes('--enqueue'))).toBe(false);
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'succeeded', phase: '已加入投稿队列', note: input.note });
  const result = (await request(f.app).get('/clips/3354/feedback').set(f.headers).expect(200)).body;
  expect(result.job.id).toBe(submitted.body.id);
});

it('stops on a failed modification, saves its reason and note, and never enqueues', async () => {
  const f = fixture();
  f.run.mockImplementationOnce(async (_command, output) => { output('Missing publishing copy: coverText'); return 2; });
  f.feedback.submit('3354', f.input()); await f.jobs.flush();
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', note: f.input().note,
    output: expect.stringContaining('Missing publishing copy: coverText') });
  const restored = new AdminJobs(path.join(f.root, 'jobs'), f.run);
  expect(restored.latest('feedback-publish', '3354')?.note).toBe(f.input().note);
});

it('holds a finished render whose review still failed instead of treating exit code zero as approval', async () => {
  const f = fixture();
  f.run.mockImplementation(async (_command, output) => { output('needs_review'); return 0; });
  f.feedback.submit('3354', f.input()); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['rebuild', 'cut']);
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', output: expect.stringContaining('复核尚未通过') });
});

it('refuses unauthorized, stale, published and excluded requests without planning or changing state', () => {
  const f = fixture();
  expect(() => f.feedback.submit('3354', { ...f.input(), publishApproved: false })).toThrow('授权');
  expect(() => f.feedback.submit('3354', { ...f.input(), revision: 'stale' })).toThrow('已变化');
  const reg = readJson(f.registryPath); reg.clips['3354'].status = 'uploaded'; atomicJson(f.registryPath, reg);
  expect(() => f.feedback.submit('3354', f.input())).toThrow('已投稿');
  reg.clips['3354'].status = 'review'; reg.clips['3354'].editorialExclusion = { reason: 'excluded' }; atomicJson(f.registryPath, reg);
  expect(() => f.feedback.submit('3354', f.input())).toThrow('已排除');
  expect(f.planner).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
});

it('detects source changes during planning and holds unsupported feedback with the original opinion intact', async () => {
  const f = fixture();
  f.planner.mockImplementationOnce(async () => { fs.appendFileSync(f.srt, '\n新的字'); return '{}'; });
  const note = f.input().note; f.feedback.submit('3354', f.input()); await f.jobs.flush();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', note, output: expect.stringContaining('已变化') });
  expect(f.run).not.toHaveBeenCalled();
  f.planner.mockResolvedValueOnce(JSON.stringify({ blockedReason: '需要原音确认，不能猜字' }));
  f.feedback.submit('3354', f.input('这几个字听不清')); await f.jobs.flush();
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ status: 'failed', note: '这几个字听不清', output: expect.stringContaining('需要原音确认') });
  expect(f.run).not.toHaveBeenCalled();
});

it('rejects model-supplied commands and unconfirmed subtitle substitutions', () => {
  const f = fixture(), detail = f.clips.detail('3354');
  expect(() => parseFeedbackPlan('{"command":"upload everything"}', detail, '核对完毕')).toThrow('不支持');
  expect(() => parseFeedbackPlan('{"corrections":[{"from":"建功","to":"建构"}]}', detail, '字可能不对')).toThrow('明确确认');
});

it('keeps full bundles on their dedicated review path and stops if they do not become review-ready', async () => {
  const f = fixture();
  const metadata = readJson(f.metadataPath); metadata.type = 'stream_activity_submission'; atomicJson(f.metadataPath, metadata);
  f.run.mockImplementation(async (_command, output) => { output('needs_review'); return 0; });
  f.feedback.submit('3354', f.input('所有P的原音和边界已核对，无需修改')); await f.jobs.flush();
  expect(f.run.mock.calls.map(([command]) => command.action)).toEqual(['approve-review']);
  expect(f.run.mock.calls[0][0].args[0]).toBe('src/scripts/stream_activity_clips.js');
  expect(f.jobs.latest('feedback-publish', '3354')?.status).toBe('failed');
});

it('persists direct copy edits before planning and gives them precedence over model suggestions', async () => {
  const f = fixture({ title: '模型建议', sourceKind: 'audience' });
  f.feedback.submit('3354', { ...f.input(), title: '用户标题', sourceKind: 'playback' }); await f.jobs.flush();
  expect(f.run.mock.calls[0][0].args).toEqual(expect.arrayContaining(['--title', '用户标题', '--source-kind', 'playback']));
  expect(f.jobs.latest('feedback-publish', '3354')).toMatchObject({ edits: { title: '用户标题', sourceKind: 'playback' }, plan: { title: '用户标题', sourceKind: 'playback' } });
});

it('restores an interrupted operation with its opinion and never replays publication automatically', () => {
  const f = fixture(), jobFile = path.join(f.root, 'jobs', '00000000-0000-0000-0000-000000000001.json');
  atomicJson(jobFile, { id: '00000000-0000-0000-0000-000000000001', action: 'feedback-publish', target: '3354', note: '已确认原词，待制作',
    status: 'running', createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:01Z', output: '', phase: '正在制作' });
  const restored = new AdminJobs(path.join(f.root, 'jobs'), f.run);
  expect(restored.latest('feedback-publish', '3354')).toMatchObject({ status: 'interrupted', note: '已确认原词，待制作' });
  expect(f.run).not.toHaveBeenCalled();
});

it('protects active uploads even when they are older than the queue page display limit', () => {
  const f = fixture();
  atomicJson(path.join(f.root, 'data/runtime/clip_upload_queue.json'), { jobs: [
    { id: 'old-active', status: 'running', clipIds: [3354] },
    ...Array.from({ length: 205 }, (_, index) => ({ id: `done-${index}`, status: 'done', clipIds: [index + 1] }))
  ] });
  expect(f.clips.queues().uploads.some((job: any) => job.id === 'old-active')).toBe(false);
  expect(() => f.feedback.submit('3354', f.input())).toThrow('已在投稿队列');
  expect(f.planner).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
});
