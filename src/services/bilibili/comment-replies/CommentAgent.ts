import fetch from 'node-fetch';
import { questionProviderSettings } from '../../live-vote/questions/DaiyuQuestionClient';
import { CommentAudience, CommentEvent, CommentPlatformBlocked, CommentReplyConfig, LIMITS, COMMENT_TOOL_LIMITS, publishableAnswer } from './CommentPolicy';
import { CommentContext, CommentPost, CommentSocialContext, fitCommentContext, safeEvidenceText,
  needsCommentEvidence, videoOnlyQuestion } from './CommentContext';
import { fanTier } from './CommentQuota';
import { commentReplySystem } from './CommentReplyStyle';
import { CommentAnswer, FeedbackVideo, COMMENT_FEEDBACK_SYSTEM, canAcknowledgeFeedbackWithoutVideo, feedbackEligible, parseFeedbackAnswer } from './CommentFeedback';
import { COMMENT_IMAGE_ALLOWANCE, COMMENT_VISUAL_RULES, createCommentVisualReader, needsCommentVisual } from './CommentVisual';
import { COMMENT_TOOL_SYSTEM, CommentAgentSources, runCommentModel } from './CommentAgentTools';

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

/** Bounded text/preview answerer with optional model-selected, read-only video/project tools. */
export function createCommentAnswerer(settings: ReturnType<typeof questionProviderSettings>, transport = fetch,
  context?: (event: CommentEvent, signal: AbortSignal) => Promise<CommentContext | undefined>,
  social?: { config: CommentReplyConfig; hotComments(event: CommentEvent, signal: AbortSignal): Promise<Array<{ text: string; likes: number }>>;
    dynamic?(id: string, signal: AbortSignal): Promise<CommentPost>;
    feedbackVideo?(event: CommentEvent, signal: AbortSignal): Promise<FeedbackVideo> },
  visual?: ReturnType<typeof createCommentVisualReader>,
  toolSources?: (event: CommentEvent) => CommentAgentSources) {
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
    const availableSources = event && toolSources ? toolSources(event) : undefined;
    const sources = availableSources?.video || availableSources?.projects?.catalog.length ? { ...availableSources,
      ...(visual && event?.type === 1 && availableSources.video && !preview ? {
        visual: (signal: AbortSignal, target?: Parameters<typeof visual>[2]) => visual(event, signal, target) } : {}) } : undefined;
    const system = (collectFeedback ? COMMENT_FEEDBACK_SYSTEM : commentReplySystem(text, event?.type,
      { knowledge: !!context, projects: !!social?.config.projectSources?.length, visual: !!visual })).replace(sources ? '无工具，' : '\u0000', '') +
      (sources ? COMMENT_TOOL_SYSTEM : '') + (preview || sources?.visual ? COMMENT_VISUAL_RULES : '');
    const visualMap = preview ? { visualPreviewSeconds: preview.times } : undefined;
    const mapBytes = Buffer.byteLength(JSON.stringify(visualMap || {}), 'utf8');
    const promptBytes = sources ? 6500 : 3456;
    const messages = fitCommentContext(text, system, evidence, surroundings, preview ? promptBytes - COMMENT_IMAGE_ALLOWANCE - mapBytes : promptBytes);
    const fittedEvidence: CommentContext | undefined = JSON.parse(messages[1].content).untrustedEvidence;
    // UTF-8 bytes give a conservative token bound for the fixed tokenizer family, plus framing/output.
    if (Buffer.byteLength(JSON.stringify(messages), 'utf8') + (preview ? mapBytes : 0) +
      (preview ? COMMENT_IMAGE_ALLOWANCE : 0) + (sources ? COMMENT_TOOL_LIMITS.outputTokens : LIMITS.outputTokens) + 256 >
      (sources ? COMMENT_TOOL_LIMITS.tokenReservation : LIMITS.tokenReservation)) {
      throw new Error('Comment prompt budget exceeded');
    }
    // Base64 is transport, not text tokens. Reserve images separately and force low detail.
    const providerMessages = preview ? [messages[0], { role: 'user', content: [
      { type: 'text', text: messages[1].content }, { type: 'text', text: JSON.stringify(visualMap) },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${preview.jpeg.toString('base64')}`, detail: 'low' } }
    ] }] : messages;
    sources?.report?.({ event: 'comment_agent_context', key: event?.key, video: !!fittedEvidence?.video,
      subtitles: !!hasVideoContent(fittedEvidence), preview: !!preview });
    try {
      const result = await runCommentModel(settings, transport, providerMessages, signal, sources, event);
      const message = result.message;
      const finalEvidence = result.video ? { ...fittedEvidence, video: result.video } as CommentContext : fittedEvidence;
      const readVideo = hasVideoContent(finalEvidence);
      const requiresEvidence = event?.type === 1 && (needsCommentEvidence(text, event.type) || !!result.video);
      const parsed = collectFeedback ? parseFeedbackAnswer(message?.content, event!, feedbackVideo!, social!.config) : undefined;
      const answer = !message?.tool_calls && result.finishReason !== 'length' &&
        (collectFeedback ? parsed?.reply : publishableAnswer(message?.content));
      if (signal.aborted || !answer || answer.includes(settings.apiKey)) throw new Error('Invalid public comment answer');
      if (requiresEvidence && mentionsSui(answer) && !supportsSui(text, finalEvidence)) {
        throw new Error('Unsupported video participant');
      }
      const descriptionComparison = result.projectsRead && !!finalEvidence?.video?.description;
      const reply = requiresEvidence && !readVideo &&
        !canAcknowledgeFeedbackWithoutVideo(text, parsed?.feedback) ?
        (descriptionComparison ? '未取到视频字幕，以下据作者简介与项目资料对比。' :
          preview || result.previewRead ? '没获取到字幕，以下仅据抽样预览画面。' : VIDEO_CONTENT_DISCLOSURE) + answer : answer;
      if (!publishableAnswer(reply)) throw new Error('Invalid public comment answer');
      return sources ? { reply, tokens: result.tokens, ...(parsed?.feedback ? { feedback: parsed.feedback } : {}) } :
        parsed?.feedback ? { reply, feedback: parsed.feedback } : reply;
    } catch (error) { if (error instanceof CommentPlatformBlocked) throw error; throw new Error('Comment generation failed'); }
  };
}
