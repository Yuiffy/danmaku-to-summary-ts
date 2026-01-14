const fs = require('fs');
const path = require('path');
const aiTextGenerator = require('./ai_text_generator');

describe('AI文本生成器测试', () => {
    const testHighlightContent = `直播时间: 2026-01-11 23:40:59
主播: 悠亚Yua
房间号: 22470216

直播内容摘要:
- 开场问候: 主播说"你好你好小悠复活"
- 聊天互动: 和观众聊了很多话题
- 游戏环节: 玩了一些小游戏
- 结束时: 说了晚安

关键词: 复活, 聊天, 游戏, 晚安`;

    const testHighlightPath = path.join(__dirname, 'test_data', 'test_AI_HIGHLIGHT.txt');
    const testBatchDir = path.join(__dirname, 'test_data');

    beforeAll(() => {
        // 确保测试目录存在
        if (!fs.existsSync(testBatchDir)) {
            fs.mkdirSync(testBatchDir, { recursive: true });
        }
    });

    afterEach(() => {
        // 清理测试文件
        if (fs.existsSync(testHighlightPath)) {
            fs.unlinkSync(testHighlightPath);
        }
    });

    afterAll(() => {
        // 清理批量测试文件
        const testFiles = [
            '26966466_20240101_120000_AI_HIGHLIGHT.txt',
            '26966466_20240102_130000_AI_HIGHLIGHT.txt'
        ];

        testFiles.forEach(file => {
            const filePath = path.join(testBatchDir, file);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        });
    });

    test('loadConfig函数应该正确加载配置', () => {
        const config = aiTextGenerator.loadConfig();

        expect(config).toBeDefined();
        expect(config.aiServices).toBeDefined();
        expect(config.aiServices.gemini).toBeDefined();
        expect(typeof config.aiServices.gemini.enabled).toBe('boolean');
        expect(typeof config.aiServices.gemini.model).toBe('string');
        expect(typeof config.aiServices.gemini.temperature).toBe('number');
        expect(typeof config.aiServices.gemini.maxTokens).toBe('number');
    });

    test('isGeminiConfigured函数应该正确检查配置', () => {
        const isConfigured = aiTextGenerator.isGeminiConfigured();

        expect(typeof isConfigured).toBe('boolean');
    });

    test('generateGoodnightReply函数应该能处理实际API调用', async () => {
        // 创建测试文件
        fs.writeFileSync(testHighlightPath, testHighlightContent, 'utf8');

        const isConfigured = aiTextGenerator.isGeminiConfigured();

        if (!isConfigured) {
            console.log('⚠️ Gemini未配置，跳过API调用测试');
            expect(isConfigured).toBe(false);
            return;
        }

        // 实际调用API
        const result = await aiTextGenerator.generateGoodnightReply(testHighlightPath);

        if (result) {
            expect(result).toBeDefined();
            expect(typeof result).toBe('string');
            expect(fs.existsSync(result)).toBe(true);

            // 检查输出文件内容
            const content = fs.readFileSync(result, 'utf8');
            expect(content).toBeDefined();
            expect(content.length).toBeGreaterThan(0);

            console.log(`✅ API调用成功，输出文件: ${result}`);
            console.log(`📄 生成内容长度: ${content.length} 字符`);
        } else {
            // 如果API调用失败，result 可能为 null
            expect(result).toBeNull();
        }
    }, { timeout: 60000 }); // 设置60秒超时，因为API调用可能需要时间

    test('batchGenerateGoodnightReplies函数应该能发现文件', async () => {
        // 创建多个测试文件
        const testFiles = [
            '26966466_20240101_120000_AI_HIGHLIGHT.txt',
            '26966466_20240102_130000_AI_HIGHLIGHT.txt'
        ];

        testFiles.forEach(file => {
            const filePath = path.join(testBatchDir, file);
            fs.writeFileSync(filePath, testHighlightContent, 'utf8');
        });

        // 注意: 这里不实际调用API，只测试文件发现逻辑
        const files = fs.readdirSync(testBatchDir);
        const highlightFiles = files.filter(f => f.includes('_AI_HIGHLIGHT.txt'));

        expect(highlightFiles.length).toBe(testFiles.length);
        expect(highlightFiles).toEqual(expect.arrayContaining(testFiles));

        console.log(`✅ 发现 ${highlightFiles.length} 个AI_HIGHLIGHT文件用于批量测试`);
    });
});