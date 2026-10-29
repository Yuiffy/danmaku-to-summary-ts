import { loadConfigLayers, readJsonObject } from '../../core/config/ConfigLayers';
import { CommentApi } from '../../services/bilibili/comment-replies/CommentApi';
import { CommentStateStore, newCommentState } from '../../services/bilibili/comment-replies/CommentState';
import { CommentWorker } from '../../services/bilibili/comment-replies/CommentWorker';
import { createCommentPauseNotify } from '../../services/bilibili/comment-replies/CommentAlertRuntime';
import { CommentFeedError } from '../../services/bilibili/comment-replies/CommentPolling';
import { runCommentReplies } from './commentReplies';

jest.mock('../../core/config/ConfigLayers', () => ({ loadConfigLayers: jest.fn(), readJsonObject: jest.fn() }));
jest.mock('../../services/live-vote/questions/DaiyuQuestionClient', () => ({ questionProviderSettings: () => ({ url: 'https://provider.invalid', apiKey: 'secret' }) }));
jest.mock('../../services/bilibili/comment-replies/CommentApi', () => ({ CommentApi: jest.fn() }));
jest.mock('../../services/bilibili/comment-replies/CommentState', () => ({
  ...jest.requireActual('../../services/bilibili/comment-replies/CommentState'), CommentStateStore: jest.fn()
}));
jest.mock('../../services/bilibili/comment-replies/CommentWorker', () => ({ CommentWorker: jest.fn() }));
jest.mock('../../services/bilibili/comment-replies/CommentAlertRuntime', () => ({ createCommentPauseNotify: jest.fn() }));

const config = { botUid: '99', unlimitedUids: [], credentialConfigPath: 'config/production.json', providerConfigPath: 'config/production.json',
  dailyTokenBudget: 4096000, maxQueue: 20, maxUserQueue: 10, pollIntervalMs: 30000, videoVision: false };
let state: ReturnType<typeof newCommentState>, save: jest.Mock, close: jest.Mock, notify: jest.Mock, feed: jest.Mock, work: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks(); state = newCommentState('99'); save = jest.fn(async () => {}); close = jest.fn(async () => {});
  notify = jest.fn(async () => true); feed = jest.fn(); work = jest.fn();
  (readJsonObject as jest.Mock).mockReturnValue(config); (loadConfigLayers as jest.Mock).mockReturnValue({ bilibili: { cookie: 'private-cookie' } });
  (CommentStateStore as jest.Mock).mockImplementation(() => ({ open: async () => state, save, close }));
  (CommentApi as jest.Mock).mockImplementation(() => ({ checkCredentials: jest.fn(), feed }));
  (CommentWorker as jest.Mock).mockImplementation(() => ({ tick: work, stop: jest.fn(), admit: jest.fn() }));
  (createCommentPauseNotify as jest.Mock).mockReturnValue(notify);
  jest.spyOn(console, 'info').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); process.exitCode = 0; });

test('the production loop alerts on a payload pause, closes the owner and retains the response diagnostic', async () => {
  feed.mockRejectedValue(new CommentFeedError(false, { feed: 'reply', reason: 'payload', httpStatus: 200, payloadStage: 'json', contentType: 'html' }));
  await runCommentReplies(['--live']);
  expect(state.paused).toBe(true); expect(state.pauseAlertAt).toEqual(expect.any(Number));
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"payloadStage":"json"'));
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"feedDiagnostics":"shape-v1"'));
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('校验=json')); expect(notify).toHaveBeenCalledTimes(1);
  expect(work).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1); expect(process.exitCode).toBe(2);
});

test('a worker pause also notifies, while notification failure cannot resume the consumer', async () => {
  feed.mockResolvedValue({ items: [], cursor: { is_end: true } }); notify.mockResolvedValue(false);
  work.mockImplementation(async () => { state.paused = true; state.pauseReason = 'like_unconfirmed'; });
  await runCommentReplies(['--live']);
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('like_unconfirmed'));
  expect(console.info).toHaveBeenCalledWith('{"event":"comment_pause_alert_failed"}');
  expect(state.paused).toBe(true); expect(close).toHaveBeenCalledTimes(1);
});

test('explicit resume clears the alert checkpoint and check mode never notifies', async () => {
  state.paused = true; state.pauseAlertAt = 1; state.pauseReason = 'platform_blocked';
  await runCommentReplies(['--resume']);
  expect(state.paused).toBe(false); expect(state.pauseAlertAt).toBeUndefined(); expect(state.pauseReason).toBeUndefined();
  expect(save).toHaveBeenCalledTimes(1); expect(notify).not.toHaveBeenCalled(); expect(feed).not.toHaveBeenCalled();
  await runCommentReplies(['--check']); expect(notify).not.toHaveBeenCalled(); expect(feed).not.toHaveBeenCalled();
});

test('a restarted saved pause cannot send the same alert again', async () => {
  state.paused = true; state.pauseAlertAt = 1;
  await runCommentReplies(['--live']);
  expect(notify).not.toHaveBeenCalled(); expect(feed).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(1);
});
