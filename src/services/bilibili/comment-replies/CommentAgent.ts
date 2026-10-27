import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { questionProviderSettings } from '../../live-vote/questions/DaiyuQuestionClient';
import { CommentAudience, CommentEvent, CommentPlatformBlocked, CommentReplyConfig, LIMITS, publishableAnswer } from './CommentPolicy';
import { CommentContext, CommentPost, CommentSocialContext, fitCommentContext, safeEvidenceText,
  needsCommentEvidence, videoOnlyQuestion } from './CommentContext';
import { fanTier } from './CommentQuota';
import { commentReplySystem } from './CommentReplyStyle';
import { CommentAnswer, FeedbackVideo, COMMENT_FEEDBACK_SYSTEM, canAcknowledgeFeedbackWithoutVideo, feedbackEligible, parseFeedbackAnswer } from './CommentFeedback';
import { COMMENT_IMAGE_ALLOWANCE, COMMENT_VISUAL_RULES, createCommentVisualReader, needsCommentVisual } from './CommentVisual';

const VIDEO_CONTENT_DISCLOSURE = '没获取到这个视频的字幕，我看不到视频内容。';
const hasVideoContent = (evidence?: CommentContext) => evidence?.video?.content === 'subtitles' &&
  evidence.video.excerpts?.some(cue => cue.text.trim());
const mentionsSui = (text: string) => /小岁|岁己|\bsui\b/iu.test(text.normalize('NFKC'));
// Only evidence retained in the actual prompt can ground the persona's names.
// A fan badge, commenter name or unrelated hot comment does not identify a video participant.
function supportsSui(text: string, evidence?: CommentContext): boolean {
  const video = evidence?.video;
  const sources = [video?.title || '', video?.description || '', ...(video?.excerpts || []).map(cue => cue.text)];
  // A viewer asking "小岁是吧" is a hypothesis, not identity evidence.
  if (!/(?:小岁|岁己|\bsui\b).{0,6}(?:是吧|对吧|吗)/iu.test(text)) sources.push(text);
  if (!videoOnlyQuestion(text)) sources.push(...(evidence?.clues || []).map(clue => clue.quote));
  return sources.some(mentionsSui);
}

/** A bounded single-turn agent. No tools, subprocesses, browsing, history, or provider retries. */
export function createCommentAnswerer(settings: ReturnType<typeof questionProviderSettings>, transport = fetch,
  context?: (event: CommentEvent, signal: AbortSignal) => Promise<CommentContext | undefined>,
  social?: { config: CommentReplyConfig; hotComments(event: CommentEvent, signal: AbortSignal): Promise<Array<{ text: string; likes: number }>>;
    dynamic?(id: string, signal: AbortSignal): Promise<CommentPost>;
    feedbackVideo?(event: CommentEvent, signal: AbortSignal): Promise<FeedbackVideo> },
  visual?: ReturnType<typeof createCommentVisualReader>) {
  const agent = settings.proxy ? new HttpsProxyAgent(settings.proxy) : undefined;
  return async (text: string, signal: AbortSignal, event?: CommentEvent, audience?: CommentAudience): Promise<string | CommentAnswer> => {
    if (signal.aborted || Array.from(text).length > LIMITS.inputChars) throw new Error('Invalid comment agent input');
    const evidence = context && event ? await context(event, signal) : undefined;
    signal.throwIfAborted();
    let surroundings: CommentSocialContext | undefined;
    if (event) {
      const knownName = social?.config.speakerNames?.[event.uid];
      surroundings = { speaker: { name: knownName || safeEvidenceText(event.authorName || '', 40) || '这位评论者',
        identity: knownName ? 'configured' : 'unverified',
        ...(social ? { fanTier: fanTier(social.config, audience), medalStatus: audience?.status || 'unavailable',
          ...(audience?.wearing ? { wearingMedal: audience.wearing.name } : {}) } : {}) } };
      if (event.type === 17 && social?.dynamic) try { surroundings.post = await social.dynamic(event.oid, signal); }
      catch (error) { if (error instanceof CommentPlatformBlocked || signal.aborted) throw error; }
      if (social) try { surroundings.hotComments = await social.hotComments(event, signal); }
      catch (error) { if (error instanceof CommentPlatformBlocked || signal.aborted) throw error; }
    }
    signal.throwIfAborted();
    let feedbackVideo: FeedbackVideo | undefined;
    if (event?.type === 1 && event.trigger === 'mention' && social?.config.feedbackOwnerUids?.length) {
      if (evidence?.videoOwnerUid) feedbackVideo = { ownerUid: evidence.videoOwnerUid, title: evidence.video?.title || '' };
      else if (social.feedbackVideo) try { feedbackVideo = await social.feedbackVideo(event, signal); }
      catch (error) { if (error instanceof CommentPlatformBlocked || signal.aborted) throw error; }
    }
    const collectFeedback = !!social && feedbackEligible(social.config, event, feedbackVideo);
    let preview;
    if (visual && event && needsCommentVisual(event, evidence)) try { preview = await visual(event, signal, evidence?.visualTarget); }
    catch (error) { if (error instanceof CommentPlatformBlocked || signal.aborted) throw error; }
    signal.throwIfAborted();
    const system = (collectFeedback ? COMMENT_FEEDBACK_SYSTEM : commentReplySystem(text, event?.type,
      { knowledge: !!context, projects: !!social?.config.projectSources?.length, visual: !!visual })) + (preview ? COMMENT_VISUAL_RULES : '');
    const visualMap = preview ? { visualPreviewSeconds: preview.times } : undefined;
    const mapBytes = Buffer.byteLength(JSON.stringify(visualMap || {}), 'utf8');
    const messages = fitCommentContext(text, system, evidence, surroundings, preview ? 3456 - COMMENT_IMAGE_ALLOWANCE - mapBytes : 3456);
    const fittedEvidence: CommentContext | undefined = JSON.parse(messages[1].content).untrustedEvidence;
    const readVideo = hasVideoContent(fittedEvidence);
    // UTF-8 bytes give a conservative token bound for the fixed tokenizer family, plus framing/output.
    if (Buffer.byteLength(JSON.stringify(messages), 'utf8') + (preview ? mapBytes : 0) +
      (preview ? COMMENT_IMAGE_ALLOWANCE : 0) + LIMITS.outputTokens + 256 > LIMITS.tokenReservation) {
      throw new Error('Comment prompt budget exceeded');
    }
    // Base64 is transport, not text tokens. Reserve images separately and force low detail.
    const providerMessages = preview ? [messages[0], { role: 'user', content: [
      { type: 'text', text: messages[1].content }, { type: 'text', text: JSON.stringify(visualMap) },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${preview.jpeg.toString('base64')}`, detail: 'low' } }
    ] }] : messages;
    try {
      const response = await transport(settings.url, {
        method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-6-luna', messages: providerMessages, max_tokens: LIMITS.outputTokens }),
        agent, signal: signal as any, redirect: 'error', timeout: LIMITS.timeoutMs, size: 32 * 1024
      });
      if (!response.ok) throw new Error('Comment provider unavailable');
      const body = await response.json() as any;
      const message = body?.choices?.[0]?.message;
      const parsed = collectFeedback ? parseFeedbackAnswer(message?.content, event!, feedbackVideo!, social!.config) : undefined;
      const answer = !message?.tool_calls && body?.choices?.[0]?.finish_reason !== 'length' &&
        (collectFeedback ? parsed?.reply : publishableAnswer(message?.content));
      if (signal.aborted || !answer || answer.includes(settings.apiKey)) throw new Error('Invalid public comment answer');
      if (event?.type === 1 && needsCommentEvidence(text, event.type) && mentionsSui(answer) && !supportsSui(text, fittedEvidence)) {
        throw new Error('Unsupported video participant');
      }
      const result = event?.type === 1 && needsCommentEvidence(text, event.type) && !readVideo &&
        !canAcknowledgeFeedbackWithoutVideo(text, parsed?.feedback) ?
        (preview ? '没获取到字幕，以下仅据抽样预览画面。' : VIDEO_CONTENT_DISCLOSURE) + answer : answer;
      if (!publishableAnswer(result)) throw new Error('Invalid public comment answer');
      return parsed?.feedback ? { reply: result, feedback: parsed.feedback } : result;
    } catch { throw new Error('Comment generation failed'); }
  };
}
