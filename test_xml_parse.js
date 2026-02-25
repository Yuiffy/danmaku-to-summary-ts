const fs = require('fs');
const xml2js = require('xml2js');

// 测试XML解析
async function testXmlParse() {
    const xmlPath = 'D:\\files\\videos\\DDTV录播\\21452505_七海Nana7mi\\2026_01_22\\录制-21452505-20260122-030723-582-真三国无双起源新DLC_merged.xml';
    
    console.log('📂 读取XML文件:', xmlPath);
    
    if (!fs.existsSync(xmlPath)) {
        console.error('❌ 文件不存在!');
        return;
    }
    
    const fileSize = fs.statSync(xmlPath).size;
    console.log(`📊 文件大小: ${(fileSize / 1024).toFixed(2)}KB`);
    
    const data = fs.readFileSync(xmlPath, 'utf8');
    console.log(`📝 文件内容长度: ${data.length} 字符`);
    
    // 使用正则表达式统计<d>标签数量
    const dMatches = data.match(/<d\s+[^>]*>[^<]*<\/d>/g);
    console.log(`🔍 正则表达式找到的<d>标签数量: ${dMatches ? dMatches.length : 0}`);
    
    if (dMatches && dMatches.length > 0) {
        console.log(`📌 前3个弹幕示例:`);
        dMatches.slice(0, 3).forEach((match, i) => {
            console.log(`  ${i + 1}. ${match}`);
        });
    }
    
    // 使用xml2js解析
    console.log('\n🔧 使用xml2js解析...');
    const parser = new xml2js.Parser({
        strict: false,
        normalize: true,
        trim: true,
        mergeAttrs: false,
        attrValueProcessors: [
            (value) => {
                if (typeof value === 'string') {
                    return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
                }
                return value;
            }
        ]
    });
    
    try {
        const result = await parser.parseStringPromise(data);
        
        console.log('📦 解析结果的根键:', Object.keys(result));
        
        // 尝试不同的键名(大小写)
        const rootKey = result.i ? 'i' : (result.I ? 'I' : null);
        console.log('📦 实际使用的根键:', rootKey);
        
        if (!rootKey) {
            console.log('❌ 找不到根节点!');
            console.log('完整result:', JSON.stringify(result, null, 2).substring(0, 1000));
            return;
        }
        
        const root = result[rootKey];
        console.log('📦 root 的键:', Object.keys(root));
        console.log('📦 root.D 的类型:', Array.isArray(root?.D) ? 'Array' : typeof root?.D);
        console.log('📦 root.D 的长度:', root?.D?.length || 0);
        
        if (root?.D && root.D.length > 0) {
            console.log(`\n📌 前3个弹幕对象:`);
            root.D.slice(0, 3).forEach((d, i) => {
                console.log(`  ${i + 1}.`, JSON.stringify(d, null, 2));
            });
        } else {
            console.log('❌ root.D 为空或不存在!');
            console.log('完整的root:', JSON.stringify(root, null, 2).substring(0, 1000));
        }
    } catch (e) {
        console.error('❌ XML解析失败:', e.message);
    }
}

testXmlParse().catch(console.error);
