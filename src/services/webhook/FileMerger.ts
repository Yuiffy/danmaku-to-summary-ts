/**
 * 文件合并器
 * 用于合并音视频文件和XML弹幕文件
 */
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getLogger } from '../../core/logging/LogManager';
import { LiveSegment } from './LiveSessionManager';

/**
 * 文件合并器
 */
export class FileMerger {
  private logger = getLogger('FileMerger');

  /**
   * 合并视频文件
   */
  async mergeVideos(segments: LiveSegment[], outputPath: string, fillGaps: boolean = true): Promise<void> {
    try {
      this.logger.info(`开始合并视频文件: ${segments.length} 个片段`);

      const dir = path.dirname(outputPath);
      const fileListPath = path.join(dir, 'filelist.txt');

      // 创建文件列表
      const fileList: string[] = [];

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        // 将路径中的反斜杠替换为正斜杠（ffmpeg concat协议要求）
        const normalizedPath = segment.videoPath.replace(/\\/g, '/');
        fileList.push(`file '${normalizedPath}'`);

        // 计算空白时间
        if (fillGaps && i < segments.length - 1) {
          const nextSegment = segments[i + 1];
          const gapTime = this.calculateGapTime(segment, nextSegment);

          if (gapTime > 0) {
            // 创建空白片段
            const blankPath = await this.createBlankVideo(dir, gapTime);
            // 将路径中的反斜杠替换为正斜杠（ffmpeg concat协议要求）
            const normalizedBlankPath = blankPath.replace(/\\/g, '/');
            fileList.push(`file '${normalizedBlankPath}'`);
            this.logger.info(`创建空白片段: ${gapTime}ms`);
          }
        }
      }

      // 写入文件列表
      fs.writeFileSync(fileListPath, fileList.join('\n'), 'utf8');

      // 使用ffmpeg合并视频
      await this.runFfmpeg([
        '-f', 'concat',
        '-safe', '0',
        '-i', fileListPath,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero', // 处理时间戳跳变
        '-fflags', '+genpts', // 重新生成PTS确保时长准确
        outputPath
      ]);

      // 删除临时文件列表
      fs.unlinkSync(fileListPath);

      this.logger.info(`视频合并完成: ${path.basename(outputPath)}`);
    } catch (error) {
      this.logger.error('合并视频文件失败', { error });
      throw error;
    }
  }

  /**
   * 合并XML弹幕文件
   */
  async mergeXmlFiles(segments: LiveSegment[], outputXmlPath: string): Promise<void> {
    try {
      this.logger.info(`开始合并XML文件: ${segments.length} 个片段`);

      let currentTimeOffset = 0; // 当前时间偏移量（毫秒）
      const mergedDanmakus: any[] = [];

      for (const segment of segments) {
        // 解析XML文件（带超时）
        const danmakus = await this.withTimeout(
          this.parseXml(segment.xmlPath),
          30000, // 30秒超时
          `解析XML文件超时: ${path.basename(segment.xmlPath)}`
        );

        // 调整弹幕时间戳
        const adjustedDanmakus = danmakus.map((d: any) => ({
          ...d,
          time: d.time + currentTimeOffset
        }));

        // 添加到合并列表
        mergedDanmakus.push(...adjustedDanmakus);

        // 更新时间偏移量（加上当前片段时长，带超时）
        const durationSec = await this.withTimeout(
          this.getSegmentDuration(segment),
          30000, // 30秒超时
          `获取视频时长超时: ${path.basename(segment.videoPath)}`
        );
        // 注意：durationSec 是秒，需要转换为毫秒累加到 currentTimeOffset
        currentTimeOffset += Math.round(durationSec * 1000);

        this.logger.info(`处理片段: ${path.basename(segment.xmlPath)}, 偏移量: ${currentTimeOffset}ms`);
      }

      // 生成合并后的XML文件
      await this.generateXml(mergedDanmakus, outputXmlPath);

      this.logger.info(`XML合并完成: ${path.basename(outputXmlPath)}`);
    } catch (error) {
      this.logger.error('合并XML文件失败', { error });
      throw error;
    }
  }

  /**
   * 添加超时包装
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
      )
    ]);
  }

  /**
   * 计算片段之间的空白时间
   */
  calculateGapTime(prevSegment: LiveSegment, nextSegment: LiveSegment): number {
    const prevEndTime = prevSegment.fileCloseTime.getTime();
    const nextStartTime = nextSegment.fileOpenTime.getTime();

    // 空白时间（毫秒）
    return nextStartTime - prevEndTime;
  }

  /**
   * 创建空白视频片段
   */
  async createBlankVideo(dir: string, durationMs: number): Promise<string> {
    const durationSec = durationMs / 1000;
    const ext = path.extname(dir === '.' ? '' : 'video.flv'); // 默认flv，但在mergeVideos里会根据情况传参
    // 实际上我们在 mergeVideos 里动态决定后缀更好
    const blankPath = path.join(dir, `blank_${durationMs}_${Date.now()}.flv`);

    // 使用ffmpeg创建空白视频（黑屏，静音）
    // 对于FLV，我们需要确保编码参数兼容
    await this.runFfmpeg([
      '-f', 'lavfi',
      '-i', `color=c=black:s=1920x1080:d=${durationSec}`,
      '-f', 'lavfi',
      '-i', `anullsrc=r=44100:cl=mono`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-t', String(durationSec),
      '-f', 'flv', // 明确指定格式
      '-y',
      blankPath
    ]);

    return blankPath;
  }

  /**
   * 获取视频时长（秒）
   */
  async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      let output = '';
      let error = '';

      ffprobe.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });

      ffprobe.stderr.on('data', (data: Buffer) => {
        error += data.toString();
      });

      ffprobe.on('close', (code: number | null) => {
        if (code === 0 && output.trim()) {
          const duration = parseFloat(output.trim());
          if (!isNaN(duration)) {
            resolve(duration);
          } else {
            reject(new Error(`Invalid duration: ${output}`));
          }
        } else {
          reject(new Error(`ffprobe failed: ${error || 'unknown error'}`));
        }
      });

      ffprobe.on('error', reject);
    });
  }

  /**
   * 获取片段时长（秒）
   */
  async getSegmentDuration(segment: LiveSegment): Promise<number> {
    return await this.getVideoDuration(segment.videoPath);
  }

  /**
   * 解析XML文件
   */
  private async parseXml(xmlPath: string): Promise<any[]> {
    try {
      const content = fs.readFileSync(xmlPath, 'utf8');
      const danmakus: any[] = [];

      // 解析弹幕条目 <d p="time,..." user="username">content</d>
      const dMatches = content.match(/<d\s+[^>]*>[^<]*<\/d>/g);
      if (dMatches) {
        dMatches.forEach((match) => {
          // 提取p属性中的时间戳（第一个值）
          const pMatch = match.match(/p="([^"]*)"/);
          if (pMatch) {
            const pValues = pMatch[1].split(',');
            const time = parseFloat(pValues[0]); // 时间戳（秒）

            // 提取user属性
            const userMatch = match.match(/user="([^"]*)"/);
            const user = userMatch ? userMatch[1] : '';

            // 提取弹幕内容（在<d>标签之后，直到</d>）
            const contentMatch = match.match(/>([^<]*)</);
            const contentText = contentMatch ? contentMatch[1] : '';

            if (!isNaN(time)) {
              danmakus.push({
                time: time * 1000, // 转换为毫秒
                content: contentText,
                user: user,
                p: pMatch[1] // 保留原始p属性
              });
            }
          }
        });
      }

      return danmakus;
    } catch (error) {
      this.logger.error('解析XML文件失败', { xmlPath, error });
      return [];
    }
  }

  /**
   * 生成XML文件
   */
  private async generateXml(danmakus: any[], outputXmlPath: string): Promise<void> {
    try {
      let xmlContent = '<?xml version="1.0" encoding="utf-8"?>\n';
      xmlContent += '<?xml-stylesheet type="text/xsl" href="#s"?>\n';
      xmlContent += '<i>\n';
      xmlContent += '  <chatserver>chat.bilibili.com</chatserver>\n';
      xmlContent += '  <chatid>0</chatid>\n';
      xmlContent += '  <mission>0</mission>\n';
      xmlContent += '  <maxlimit>1000</maxlimit>\n';
      xmlContent += '  <state>0</state>\n';
      xmlContent += '  <real_name>0</real_name>\n';
      xmlContent += '  <source>0</source>\n';
      xmlContent += '  <BililiveRecorder version="2.18.0" />\n';
      xmlContent += '  <BililiveRecorderRecordInfo roomid="0" shortid="0" name="Merged" title="Merged" areanameparent="" areanamechild="" start_time="" />\n';
      xmlContent += '  <BililiveRecorderXmlStyle><z:stylesheet version="1.0" id="s" xml:id="s" xmlns:z="http://www.w3.org/1999/XSL/Transform"><z:output method="html"/><z:template match="/"><html><meta name="viewport" content="width=device-width"/><title>mikufans录播姬弹幕文件 - <z:value-of select="/i/BililiveRecorderRecordInfo/@name"/></title><style>body{margin:0}h1,h2,p,table{margin-left:5px}table{border-spacing:0}td,th{border:1px solid grey;padding:1px}th{position:sticky;top:0;background:#4098de}tr:hover{background:#d9f4ff}div{overflow:auto;max-height:80vh;max-width:100vw;width:fit-content}</style><h1><a href="https://rec.danmuji.org">mikufans录播姬</a>弹幕XML文件</h1><p>本文件不支持在 IE 浏览器里预览，请使用 Chrome Firefox Edge 等浏览器。</p><p>文件用法参考文档 <a href="https://rec.danmuji.org/user/danmaku/">https://rec.danmuji.org/user/danmaku/</a></p><table><tr><td>录播姬版本</td><td><z:value-of select="/i/BililiveRecorder/@version"/></td></tr><tr><td>房间号</td><td><z:value-of select="/i/BililiveRecorderRecordInfo/@roomid"/></td></tr><tr><td>主播名</td><td><z:value-of select="/i/BililiveRecorderRecordInfo/@name"/></td></tr><tr><td>录制开始时间</td><td><z:value-of select="/i/BililiveRecorderRecordInfo/@start_time"/></td></tr><tr><td><a href="#d">弹幕</a></td><td>共<z:value-of select="count(/i/d)"/>条记录</td></tr><tr><td><a href="#guard">上船</a></td><td>共<z:value-of select="count(/i/guard)"/>条记录</td></tr><tr><td><a href="#sc">SC</a></td><td>共<z:value-of select="count(/i/sc)"/>条记录</td></tr><tr><td><a href="#gift">礼物</a></td><td>共<z:value-of select="count(/i/gift)"/>条记录</td></tr></table><h2 id="d">弹幕</h2><div id="dm"><table><tr><th>用户名</th><th>出现时间</th><th>用户ID</th><th>弹幕</th><th>参数</th></tr><z:for-each select="/i/d"><tr><td><z:value-of select="@user"/></td><td></td><td></td><td><z:value-of select="."/></td><td><z:value-of select="@p"/></td></tr></z:for-each></table></div><script>Array.from(document.querySelectorAll(\'#dm tr\')).slice(1).map(t=>t.querySelectorAll(\'td\')).forEach(t=>{let p=t[4].textContent.split(\',\'),a=p[0];t[1].textContent=`${(Math.floor(a/60/60)+\'\').padStart(2,0)}:${(Math.floor(a/60%60)+\'\').padStart(2,0)}:${(a%60).toFixed(3).padStart(6,0)}`;t[2].innerHTML=`<a target=_blank rel="nofollow noreferrer" href="https://space.bilibili.com/${p[6]}">${p[6]}</a>`})</script><h2 id="guard">舰长购买</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>舰长等级</th><th>购买数量</th><th>出现时间</th></tr><z:for-each select="/i/guard"><tr><td><z:value-of select="@user"/></td><td><a rel="nofollow noreferrer"><z:attribute name="href"><z:text>https://space.bilibili.com/</z:text><z:value-of select="@uid" /></z:attribute><z:value-of select="@uid"/></a></td><td><z:value-of select="@level"/></td><td><z:value-of select="@count"/></td><td><z:value-of select="@ts"/></td></tr></z:for-each></table></div><h2 id="sc">SuperChat 醒目留言</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>内容</th><th>显示时长</th><th>价格</th><th>出现时间</th></tr><z:for-each select="/i/sc"><tr><td><z:value-of select="@user"/></td><td><a rel="nofollow noreferrer"><z:attribute name="href"><z:text>https://space.bilibili.com/</z:text><z:value-of select="@uid" /></z:attribute><z:value-of select="@uid"/></a></td><td><z:value-of select="."/></td><td><z:value-of select="@time"/></td><td><z:value-of select="@price"/></td><td><z:value-of select="@ts"/></td></tr></z:for-each></table></div><h2 id="gift">礼物</h2><div><table><tr><th>用户名</th><th>用户ID</th><th>礼物名</th><th>礼物数量</th><th>出现时间</th></tr><z:for-each select="/i/gift"><tr><td><z:value-of select="@user"/></td><td><a rel="nofollow noreferrer"><z:attribute name="href"><z:text>https://space.bilibili.com/</z:text><z:value-of select="@uid" /></z:attribute><z:value-of select="@uid"/></a></td><td><z:value-of select="@giftname"/></td><td><z:value-of select="@giftcount"/></td><td><z:value-of select="@ts"/></td></tr></z:for-each></table></div></html></z:template></z:stylesheet></BililiveRecorderXmlStyle>\n';

      // 辅助函数：转义 XML 特殊字符
      const escapeXml = (unsafe: string) => {
        return unsafe.replace(/[<>&"']/g, (c) => {
          switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '"': return '&quot;';
            case "'": return '&apos;';
            default: return c;
          }
        });
      };

      // 添加弹幕条目
      danmakus.forEach((d: any) => {
        // 将毫秒转换为秒
        const timeInSeconds = (d.time / 1000).toFixed(3);
        // 重新构建p属性，更新时间戳
        const pValues = d.p.split(',');
        pValues[0] = timeInSeconds;
        const newP = pValues.join(',');
        const escapedContent = escapeXml(d.content);
        const escapedUser = escapeXml(d.user);
        xmlContent += `  <d p="${newP}" user="${escapedUser}">${escapedContent}</d>\n`;
      });

      xmlContent += '</i>';

      fs.writeFileSync(outputXmlPath, xmlContent, 'utf8');
    } catch (error) {
      this.logger.error('生成XML文件失败', { outputXmlPath, error });
      throw error;
    }
  }

  /**
   * 运行ffmpeg命令
   */
  private async runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });

      let stderrOutput = '';

      ffmpeg.stderr?.on('data', (data: Buffer) => {
        stderrOutput += data.toString();
      });

      ffmpeg.on('close', (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          const errorMsg = stderrOutput || `Unknown error`;
          this.logger.error(`ffmpeg执行失败`, {
            code,
            args: args.join(' '),
            stderr: errorMsg.substring(0, 500) // 只记录前500字符
          });
          reject(new Error(`ffmpeg exited with code ${code}: ${errorMsg.substring(0, 200)}`));
        }
      });

      ffmpeg.on('error', (error) => {
        this.logger.error(`ffmpeg进程错误`, { error: error.message });
        reject(error);
      });
    });
  }

  /**
   * 获取最大的片段（按文件大小）
   */
  getLargestSegment(segments: LiveSegment[]): LiveSegment | null {
    if (segments.length === 0) {
      return null;
    }

    let largestSegment = segments[0];
    let largestSize = 0;

    for (const segment of segments) {
      try {
        const stats = fs.statSync(segment.videoPath);
        if (stats.size > largestSize) {
          largestSize = stats.size;
          largestSegment = segment;
        }
      } catch (error) {
        this.logger.warn(`无法获取文件大小: ${segment.videoPath}`, { error });
      }
    }

    this.logger.info(`获取最大片段: ${path.basename(largestSegment.videoPath)} (${(largestSize / 1024 / 1024).toFixed(2)}MB)`);
    return largestSegment;
  }

  /**
   * 备份原始片段到bak文件夹
   */
  async backupSegments(segments: LiveSegment[], outputDir: string): Promise<void> {
    const bakDir = path.join(outputDir, 'bak');

    // 创建bak文件夹
    if (!fs.existsSync(bakDir)) {
      fs.mkdirSync(bakDir, { recursive: true });
    }

    // 移动文件到bak文件夹
    for (const segment of segments) {
      const videoBasename = path.basename(segment.videoPath);
      const xmlBasename = path.basename(segment.xmlPath);

      const videoDest = path.join(bakDir, videoBasename);
      const xmlDest = path.join(bakDir, xmlBasename);

      // 移动视频文件
      if (fs.existsSync(segment.videoPath)) {
        fs.renameSync(segment.videoPath, videoDest);
        this.logger.info(`备份视频文件: ${videoBasename}`);
      }

      // 移动XML文件
      if (fs.existsSync(segment.xmlPath)) {
        fs.renameSync(segment.xmlPath, xmlDest);
        this.logger.info(`备份XML文件: ${xmlBasename}`);
      }
    }
  }

  /**
   * 复制封面图
   */
  async copyCover(segments: LiveSegment[], outputDir: string): Promise<void> {
    if (segments.length === 0) {
      return;
    }

    // 从第一个片段查找封面图
    const firstSegment = segments[0];
    const videoDir = path.dirname(firstSegment.videoPath);
    const videoBasename = path.basename(firstSegment.videoPath, path.extname(firstSegment.videoPath));

    // 查找可能的封面图文件
    const coverExtensions = ['.jpg', '.png', '.webp'];
    let coverPath: string | null = null;

    for (const ext of coverExtensions) {
      const possibleCover = path.join(videoDir, `${videoBasename}${ext}`);
      if (fs.existsSync(possibleCover)) {
        coverPath = possibleCover;
        break;
      }
    }

    // 如果找到封面图，复制到输出目录
    if (coverPath) {
      const coverBasename = path.basename(coverPath);
      const coverDest = path.join(outputDir, coverBasename);

      fs.copyFileSync(coverPath, coverDest);
      this.logger.info(`复制封面图: ${coverBasename}`);
    }
  }
}
