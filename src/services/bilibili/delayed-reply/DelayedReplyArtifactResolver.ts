import * as fs from 'fs';
import * as path from 'path';
import { ConfigProvider } from '../../../core/config/ConfigProvider';
import { getLogger } from '../../../core/logging/LogManager';

export interface DelayedReplyArtifactPaths {
  goodnightTextPath: string;
  comicImagePath?: string;
}

/** Resolves stale generated-output paths without owning delayed-reply state. */
export class DelayedReplyArtifactResolver {
  private readonly logger = getLogger('DelayedReplyArtifactResolver');

  resolve(
    roomId: string,
    goodnightTextPath: string,
    comicImagePath?: string
  ): DelayedReplyArtifactPaths {
    const normalizedTextPath = path.normalize(goodnightTextPath);
    const normalizedComicPath = comicImagePath ? path.normalize(comicImagePath) : comicImagePath;

    if (fs.existsSync(normalizedTextPath)) {
      return {
        goodnightTextPath: normalizedTextPath,
        comicImagePath: normalizedComicPath
      };
    }

    const repairedTextPath = this.findExistingGoodnightPath(roomId, normalizedTextPath);
    if (!repairedTextPath) {
      return {
        goodnightTextPath: normalizedTextPath,
        comicImagePath: normalizedComicPath
      };
    }

    const repairedComicPath = this.deriveComicPathFromGoodnightPath(repairedTextPath);
    const finalComicPath = repairedComicPath || normalizedComicPath;
    this.logger.warn('修复延迟回复路径：传入路径不存在，已按房间/录制时间匹配真实文件', {
      roomId,
      originalGoodnightTextPath: goodnightTextPath,
      repairedGoodnightTextPath: repairedTextPath,
      originalComicImagePath: comicImagePath,
      repairedComicImagePath: finalComicPath
    });

    return {
      goodnightTextPath: repairedTextPath,
      comicImagePath: finalComicPath
    };
  }

  private findExistingGoodnightPath(roomId: string, badTextPath: string): string | undefined {
    const recordingMatch = badTextPath.match(
      new RegExp(`${this.escapeRegExp(String(roomId))}-(\\d{8})-(\\d{6})-(\\d{3})`)
    );
    if (!recordingMatch) {
      return undefined;
    }

    const [, yyyymmdd, hhmmss, sequence] = recordingMatch;
    const fingerprint = `${roomId}-${yyyymmdd}-${hhmmss}-${sequence}`;
    const dateDirName = `${yyyymmdd.slice(0, 4)}_${yyyymmdd.slice(4, 6)}_${yyyymmdd.slice(6, 8)}`;
    const searchDirs = this.getSearchDirs(roomId, dateDirName, badTextPath);
    const candidates: string[] = [];

    for (const dir of searchDirs) {
      try {
        if (!fs.existsSync(dir)) {
          continue;
        }

        for (const fileName of fs.readdirSync(dir)) {
          if (fileName.includes(fingerprint) && fileName.endsWith('_晚安回复.md')) {
            candidates.push(path.join(dir, fileName));
          }
        }
      } catch (error) {
        this.logger.warn('扫描晚安回复候选目录失败', {
          roomId,
          dir,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return candidates
      .filter(candidate => fs.existsSync(candidate))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }

  private getSearchDirs(roomId: string, dateDirName: string, badTextPath: string): string[] {
    const dirs = new Set<string>();
    const parsedBadPath = path.parse(badTextPath);
    if (parsedBadPath.dir && fs.existsSync(parsedBadPath.dir)) {
      dirs.add(parsedBadPath.dir);
    }

    for (const basePath of this.getRecordingBasePathCandidates()) {
      try {
        if (!fs.existsSync(basePath)) {
          continue;
        }

        for (const roomDirName of fs.readdirSync(basePath)) {
          if (roomDirName.startsWith(`${roomId}_`)) {
            dirs.add(path.join(basePath, roomDirName, dateDirName));
          }
        }
      } catch (error) {
        this.logger.warn('扫描录播根目录失败', {
          roomId,
          basePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return Array.from(dirs);
  }

  private getRecordingBasePathCandidates(): string[] {
    const candidates = new Set<string>();
    try {
      const configBasePath = ConfigProvider.getConfig().webhook?.endpoints?.mikufans?.basePath;
      if (configBasePath) {
        candidates.add(path.normalize(configBasePath));
      }
    } catch {
      // Configuration may not be initialized in narrow unit tests.
    }

    candidates.add(path.normalize('D:/files/videos/DDTV录播'));
    return Array.from(candidates);
  }

  private deriveComicPathFromGoodnightPath(goodnightTextPath: string): string | undefined {
    const comicPath = goodnightTextPath.replace(/_晚安回复\.md$/u, '_COMIC_FACTORY.png');
    return comicPath !== goodnightTextPath ? comicPath : undefined;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
