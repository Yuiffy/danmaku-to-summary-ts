import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../../core/logging/LogManager';

/** Reads generated sidecars and formats the operator-facing diagnostic summary. */
export class DelayedReplyDiagnostics {
  private readonly logger = getLogger('DelayedReplyDiagnostics');

  getTextGenerationInfo(goodnightTextPath: string, comicImagePath?: string): string | undefined {
    const goodnightInfo = this.getGoodnightTextGenerationInfo(goodnightTextPath);
    const comicScriptInfo = this.getComicScriptGenerationInfo(comicImagePath);

    return [
      this.getAsrInfo(goodnightTextPath),
      goodnightInfo ? `晚安文本: ${goodnightInfo}` : undefined,
      comicScriptInfo ? `漫画脚本文本: ${comicScriptInfo}` : undefined
    ].filter(Boolean).join('\n') || undefined;
  }

  getAsrInfo(goodnightTextPath: string): string | undefined {
    try {
      const asrMetaPath = goodnightTextPath.replace(/_晚安回复\.md$/u, '.asr_meta.json');
      if (!fs.existsSync(asrMetaPath)) {
        return undefined;
      }
      const meta = JSON.parse(fs.readFileSync(asrMetaPath, 'utf8'));
      const backend = meta.backend || 'unknown';
      const profile = meta.modelProfile || 'default';
      const elapsed = Number(meta.elapsedSeconds || 0);
      const duration = Number(meta.mediaDurationSeconds || 0);
      const speed = elapsed > 0 && duration > 0 ? duration / elapsed : null;
      const modelLabel = profile === 'finetuned'
        ? `微调(${path.basename(String(meta.finetunedModel || meta.model || 'unknown'))})`
        : `原版(${meta.model || 'paraformer-zh'})`;
      return [
        `ASR: ${backend} / ${modelLabel}`,
        elapsed > 0 ? `耗时: ${elapsed.toFixed(1)}s` : undefined,
        speed ? `速度: ${speed.toFixed(2)}x` : undefined,
        meta.realtimeFactor !== null && meta.realtimeFactor !== undefined
          ? `RTF: ${Number(meta.realtimeFactor).toFixed(3)}`
          : undefined,
        this.getSpeakerProcessingInfo(meta.speakerProcessing)
      ].filter(Boolean).join('，');
    } catch (error) {
      this.logger.warn('读取 ASR 元数据失败', {
        goodnightTextPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return 'ASR: 元数据读取失败';
    }
  }

  getComicScriptGenerationInfo(comicImagePath?: string): string | undefined {
    if (!comicImagePath) {
      return undefined;
    }

    const parsedPath = path.parse(comicImagePath);
    const scriptBaseName = parsedPath.name.replace(/_COMIC_FACTORY$/i, '_COMIC_SCRIPT');
    const scriptPath = path.join(parsedPath.dir, `${scriptBaseName}.txt`);
    const metaPath = path.join(parsedPath.dir, `${scriptBaseName}_META.json`);

    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const provider = meta.provider || '未知服务';
        const model = meta.model || '未知模型';
        const fallback = meta.fallback ? '，fallback: 是' : '';
        const reason = meta.reason ? `，原因: ${String(meta.reason).slice(0, 200)}` : '';
        const status = meta.status === 'success'
          ? '成功'
          : meta.status === 'failure'
            ? '失败'
            : String(meta.status || '未知');
        const attempts = Array.isArray(meta.attempts) ? meta.attempts : [];
        const successfulAttempt = attempts.find((attempt: any) => attempt?.status === 'success');
        const cacheInfo = this.formatCacheInfo(successfulAttempt);
        return `模型: ${model}，服务: ${provider}，状态: ${status}${fallback}${cacheInfo}${reason}`;
      }

      if (fs.existsSync(scriptPath)) {
        return '模型: 未知（旧脚本未记录元数据）';
      }

      return '模型: 未知（未找到漫画脚本）';
    } catch (error) {
      this.logger.warn('读取漫画脚本文本生成元数据失败', {
        comicImagePath,
        metaPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return '模型: 未知（元数据读取失败）';
    }
  }

  getComicGenerationInfo(comicImagePath?: string): string | undefined {
    if (!comicImagePath) {
      return undefined;
    }

    const parsedPath = path.parse(comicImagePath);
    const metaCandidates = [
      path.join(parsedPath.dir, `${parsedPath.name}_META.json`),
      path.join(parsedPath.dir, `${parsedPath.name.replace(/_COMIC_FACTORY$/i, '')}_COMIC_FACTORY_META.json`)
    ];
    const metaPath = metaCandidates.find(candidate => fs.existsSync(candidate));
    if (!metaPath) {
      const modeInfo = '漫画模式: 未记录（无法判定新版/旧版）';
      const imageInfo = fs.existsSync(comicImagePath)
        ? '图片已生成，未找到生图元数据'
        : '图片未生成，未找到生图失败元数据';
      return `${modeInfo}\n${imageInfo}`;
    }

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const modeInfo = this.formatComicStorytellingMode(meta);
      const status = meta.status === 'success'
        ? '成功'
        : meta.status === 'failure'
          ? '失败'
          : String(meta.status || '未知');
      const routeAttempts = Array.isArray(meta.routeAttempts) ? meta.routeAttempts : [];
      const successfulRoute = routeAttempts.find((attempt: any) => attempt?.status === 'success');
      const provider = meta.provider || successfulRoute?.provider || '未知服务';
      const model = meta.model || successfulRoute?.model || '未知模型';
      const endpoint = meta.endpoint || '未知接口';
      const reason = meta.reason ? String(meta.reason) : '';
      const attempts = Array.isArray(meta.attempts) ? meta.attempts : [];
      const successfulAttempt = attempts.find((attempt: any) => attempt?.status === 'success');
      const usage = meta.usage || successfulAttempt?.usage || {};
      const usageDetails = usage.input_tokens_details || usage.prompt_tokens_details || {};
      const inputTokens = this.getFirstFiniteNumber(usage.input_tokens, usage.prompt_tokens);
      const outputTokens = this.getFirstFiniteNumber(usage.output_tokens, usage.completion_tokens);
      const imageInputTokens = this.getFiniteNumber(usageDetails.image_tokens);
      const textInputTokens = this.getFiniteNumber(usageDetails.text_tokens);
      const usageInfo = inputTokens !== undefined || outputTokens !== undefined
        ? [
            inputTokens !== undefined ? `输入 ${inputTokens}` : undefined,
            imageInputTokens !== undefined ? `图片 ${imageInputTokens}` : undefined,
            textInputTokens !== undefined ? `文字 ${textInputTokens}` : undefined,
            outputTokens !== undefined ? `输出 ${outputTokens}` : undefined
          ].filter(Boolean).join('，') + ' tokens'
        : undefined;
      const combinedAttempts = routeAttempts.length > 0 ? routeAttempts : attempts;
      const formatRoute = (routeProvider: string, routeModel: string, routeEndpoint: string) =>
        `${routeProvider}/${routeModel}${routeEndpoint !== '未知接口' && routeEndpoint !== 'unknown' ? ` (${routeEndpoint})` : ''}`;
      const lastAttempts = combinedAttempts.slice(-3).map((attempt: any) => {
        const attemptProvider = attempt?.provider || provider || '未知服务';
        const attemptModel = attempt?.model || '未知模型';
        const attemptEndpoint = attempt?.endpoint || '未知接口';
        const attemptStatus = attempt?.status || 'unknown';
        const attemptReason = attempt?.reason ? `: ${String(attempt.reason).slice(0, 120)}` : '';
        return `- ${formatRoute(attemptProvider, attemptModel, attemptEndpoint)} / ${attemptStatus}${attemptReason}`;
      });
      const summary = `${formatRoute(provider, model, endpoint)}: ${status}`;

      return [
        modeInfo,
        `模型: ${summary}`,
        usageInfo ? `用量: ${usageInfo}` : undefined,
        reason ? `原因: ${reason}` : undefined,
        lastAttempts.length > 1 || status !== '成功' ? `尝试:\n${lastAttempts.join('\n')}` : undefined
      ].filter(Boolean).join('\n');
    } catch (error) {
      this.logger.warn('读取生图元数据失败', {
        comicImagePath,
        metaPath,
        error: error instanceof Error ? error.message : String(error)
      });
      const modeInfo = '漫画模式: 未知（生图元数据读取失败）';
      const imageInfo = fs.existsSync(comicImagePath)
        ? '图片已生成，但生图元数据读取失败'
        : '图片未生成，且生图元数据读取失败';
      return `${modeInfo}\n${imageInfo}`;
    }
  }

  private getSpeakerProcessingInfo(speakerProcessing: any): string | undefined {
    if (!speakerProcessing || typeof speakerProcessing !== 'object') {
      return undefined;
    }

    const rawStatus = speakerProcessing.status !== null && speakerProcessing.status !== undefined
      ? String(speakerProcessing.status)
      : '';
    const status = rawStatus.trim().toLowerCase();
    const decision = speakerProcessing.decision !== null && speakerProcessing.decision !== undefined
      ? String(speakerProcessing.decision)
      : '';
    const normalizedDecision = decision.trim().toLowerCase();
    const mode = speakerProcessing.mode !== null && speakerProcessing.mode !== undefined
      ? String(speakerProcessing.mode)
      : '';
    const reason = speakerProcessing.reason !== null && speakerProcessing.reason !== undefined
      ? String(speakerProcessing.reason)
      : '';
    const rawStrategy = speakerProcessing.fullClusteringStrategy
      ?? speakerProcessing.full_clustering_strategy;
    const strategy = rawStrategy === 'probe_centroid_assignment'
      ? '探测簇中心分配'
      : rawStrategy === 'full_clustering_fallback'
        ? '全量聚类回退'
        : rawStrategy === 'full_clustering'
          ? '全量聚类'
          : undefined;
    const fullRunValue = speakerProcessing.fullRun ?? speakerProcessing.full_run;

    if (status === 'disabled' || normalizedDecision === 'disabled' || mode === 'disabled') {
      return undefined;
    }

    let statusLabel: string;
    if (status.includes('fail') || status.includes('error')) {
      statusLabel = '处理失败（ASR 已保留）';
    } else if (fullRunValue === true) {
      statusLabel = '已完整处理';
    } else if (
      fullRunValue === false ||
      status.includes('skip') ||
      normalizedDecision.includes('single')
    ) {
      statusLabel = '抽样判定单人，已跳过全量';
    } else if (
      status === 'completed' ||
      status === 'complete' ||
      status === 'success' ||
      normalizedDecision.includes('multi') ||
      normalizedDecision.includes('multiple')
    ) {
      statusLabel = '已完整处理';
    } else {
      statusLabel = rawStatus ? `状态: ${rawStatus}` : '状态未知';
    }

    const context = [
      mode ? `模式: ${mode}` : undefined,
      decision ? `判定: ${decision}` : undefined,
      reason ? `原因: ${reason}` : undefined,
      strategy ? `策略: ${strategy}` : undefined
    ].filter(Boolean).join('，');
    const sampleParts = [
      this.formatSpeakerCount(speakerProcessing.sampledChunks ?? speakerProcessing.sampled_chunks, '段'),
      this.formatSpeakerCount(speakerProcessing.validChunks ?? speakerProcessing.valid_chunks, '段有效'),
      this.formatSpeakerCount(speakerProcessing.detectedClusters ?? speakerProcessing.detected_clusters, '个检测簇'),
      this.formatSpeakerCount(speakerProcessing.supportedClusters ?? speakerProcessing.supported_clusters, '个支持簇'),
      this.formatSpeakerSeconds(
        speakerProcessing.sampledSpeechSeconds
          ?? speakerProcessing.sampled_speech_seconds
          ?? speakerProcessing.sampled_speech_s,
        '语音'
      )
    ].filter(Boolean);
    const timingInfo = this.getSpeakerTimingInfo(speakerProcessing.timings);

    return [
      `说话人: ${statusLabel}${context ? `（${context}）` : ''}`,
      sampleParts.length > 0 ? `抽样: ${sampleParts.join('/')}` : undefined,
      timingInfo
    ].filter(Boolean).join('；');
  }

  private getSpeakerTimingInfo(timings: any): string | undefined {
    if (!timings || typeof timings !== 'object') {
      return undefined;
    }

    const probeEmbedding = this.getFirstFiniteNumber(timings.probeEmbedding, timings.probe_embedding_s);
    const probeClustering = this.getFirstFiniteNumber(timings.probeClustering, timings.probe_clustering_s);
    const probeParts = [probeEmbedding, probeClustering].filter((value): value is number => value !== undefined);
    const probe = probeParts.length > 0
      ? probeParts.reduce((sum, value) => sum + value, 0)
      : undefined;
    const full = this.getFirstFiniteNumber(timings.fullEmbedding, timings.full_embedding_s);
    const clustering = this.getFirstFiniteNumber(timings.fullClustering, timings.full_clustering_s);
    const reference = this.getFirstFiniteNumber(
      timings.reference,
      timings.referenceEmbedding,
      timings.reference_embedding_s
    );
    const matching = this.getFirstFiniteNumber(
      timings.matching,
      timings.speakerMatching,
      timings.reference_matching_s
    );
    const total = this.getFirstFiniteNumber(timings.total, timings.total_s);
    const parts = [
      this.formatSpeakerTiming(probe, '探测'),
      this.formatSpeakerTiming(full, '全量'),
      this.formatSpeakerTiming(clustering, '聚类'),
      this.formatSpeakerTiming(reference, '参考'),
      this.formatSpeakerTiming(matching, '匹配'),
      this.formatSpeakerTiming(total, '总计')
    ].filter(Boolean);

    return parts.length > 0 ? `说话人耗时: ${parts.join(' / ')}` : undefined;
  }

  private getGoodnightTextGenerationInfo(textPath: string): string | undefined {
    try {
      if (!fs.existsSync(textPath)) {
        return undefined;
      }

      const content = fs.readFileSync(textPath, 'utf8');
      const frontMatter = this.parseFrontMatter(content);
      if (!frontMatter) {
        return '模型: 未知（无元数据）';
      }

      const provider = frontMatter.provider || '未知服务';
      const model = frontMatter.model || '未知模型';
      const fallback = frontMatter.fallback === 'true' ? '，fallback: 是' : '';
      return `模型: ${model}，服务: ${provider}${fallback}${this.formatCacheInfo(frontMatter)}`;
    } catch (error) {
      this.logger.warn('读取晚安文本生成元数据失败', {
        textPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return '模型: 未知（元数据读取失败）';
    }
  }

  private formatCacheInfo(values: Record<string, unknown> | undefined): string {
    const promptTokens = this.getFiniteNumber(values?.promptTokens);
    const cachedTokens = this.getFiniteNumber(values?.cachedTokens);
    const cacheWriteTokens = this.getFiniteNumber(values?.cacheWriteTokens);
    if (promptTokens === undefined) {
      return '';
    }
    if (cachedTokens === undefined) {
      return `，输入: ${promptTokens} tokens（缓存命中量未报告）`;
    }
    const cacheWriteInfo = cacheWriteTokens !== undefined
      ? `，缓存写入: ${cacheWriteTokens} tokens`
      : '';
    return `，输入缓存: ${cachedTokens}/${promptTokens} tokens${cacheWriteInfo}`;
  }

  private parseFrontMatter(content: string): Record<string, string> | null {
    const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
      return null;
    }

    const result: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const item = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
      if (item) {
        result[item[1]] = item[2].replace(/^"|"$/g, '');
      }
    }
    return result;
  }

  private formatComicStorytellingMode(meta: any): string {
    const variant = String(meta?.storytellingVariant || '').trim();
    const mode = variant === 'immersive_v1'
      ? '新版沉浸式（灰度组 immersive_v1）'
      : variant === 'control'
        ? '旧版对照组（control）'
        : variant
          ? `未知变体（${variant}）`
          : '未记录（无法判定新版/旧版）';
    const reasonLabels: Record<string, string> = {
      forced: '强制指定',
      'stable-rollout': '稳定灰度',
      'experiment-disabled': '实验关闭'
    };
    const assignmentReason = String(meta?.storytellingAssignmentReason || '').trim();
    const assignment = reasonLabels[assignmentReason] || assignmentReason;
    const rollout = this.getFiniteNumber(meta?.storytellingImmersivePercent);
    const bucket = this.getFiniteNumber(meta?.storytellingBucket);
    const details = [
      assignment ? `分配: ${assignment}` : undefined,
      rollout !== undefined ? `新版比例: ${rollout}%` : undefined,
      bucket !== undefined ? `桶: ${(bucket / 100).toFixed(2)}` : undefined
    ].filter(Boolean);
    return `漫画模式: ${mode}${details.length > 0 ? `；${details.join('；')}` : ''}`;
  }

  private getFirstFiniteNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
      const number = this.getFiniteNumber(value);
      if (number !== undefined) {
        return number;
      }
    }
    return undefined;
  }

  private getFiniteNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') {
      return undefined;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  private formatSpeakerCount(value: unknown, suffix: string): string | undefined {
    const number = Array.isArray(value) ? value.length : this.getFiniteNumber(value);
    return number !== undefined ? `${number}${suffix}` : undefined;
  }

  private formatSpeakerSeconds(value: unknown, label: string): string | undefined {
    const seconds = this.getFiniteNumber(value);
    return seconds !== undefined ? `${seconds.toFixed(1)}s${label}` : undefined;
  }

  private formatSpeakerTiming(value: number | undefined, label: string): string | undefined {
    return value !== undefined ? `${label} ${value.toFixed(1)}s` : undefined;
  }
}
