#!/usr/bin/env node

const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const os = require('os');
const path = require('path');
const configLoader = require('./config-loader');
const { sendWeChatMarkdown: sendSegmentedWeChatMarkdown } = require('./wechat_work_markdown');

const DEFAULT_STATE_FILE = path.join(os.tmpdir(), 'danmaku_tuzi_balance_alert_state.json');

function formatNumber(value, digits = 2) {
    if (!Number.isFinite(value)) {
        return 'unknown';
    }
    return value.toFixed(digits).replace(/\.?0+$/, '');
}

function getTuZiConfig(config) {
    return config.ai?.text?.tuZi || config.aiServices?.tuZi || {};
}

function getBalanceConfig(config) {
    return {
        enabled: config.ai?.tuZiBalance?.enabled !== false,
        accessToken: process.env.TUZI_BALANCE_TOKEN || config.ai?.tuZiBalance?.accessToken || '',
        newApiUser: process.env.TUZI_NEW_API_USER || config.ai?.tuZiBalance?.newApiUser || '',
        lowBalanceThreshold: Number(config.ai?.tuZiBalance?.lowBalanceThreshold ?? 5),
        notifyOnSuccess: config.ai?.tuZiBalance?.notifyOnSuccess !== false,
        alertCooldownMinutes: Number(config.ai?.tuZiBalance?.alertCooldownMinutes ?? 30),
        stateFile: config.ai?.tuZiBalance?.stateFile || DEFAULT_STATE_FILE
    };
}

function parseArgs(argv) {
    const options = {
        dryRun: argv.includes('--dry-run'),
        lowOnly: argv.includes('--low-only'),
        force: argv.includes('--force'),
        reason: ''
    };

    const reasonIndex = argv.indexOf('--reason');
    if (reasonIndex >= 0 && reasonIndex < argv.length - 1) {
        options.reason = String(argv[reasonIndex + 1] || '').trim();
    }
    return options;
}

function toFwdSlash(s) {
    return String(s || '').replace(/\\+/g, '/');
}

async function sendWeChatMarkdown(webhookUrl, content) {
    if (!webhookUrl) {
        console.warn('⚠️ 未配置企业微信 webhookUrl，跳过余额通知');
        return false;
    }
    return sendSegmentedWeChatMarkdown(webhookUrl, content, { timeout: 10000 });
}

function readState(stateFile) {
    try {
        if (stateFile && fs.existsSync(stateFile)) {
            return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        }
    } catch (error) {
        console.warn(`⚠️ 读取tuZi余额告警状态失败，将重建: ${error.message}`);
    }
    return {};
}

function writeState(stateFile, state) {
    try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.warn(`⚠️ 保存tuZi余额告警状态失败: ${error.message}`);
    }
}

function shouldSendLowAlert(balanceConfig, options) {
    if (options.force || options.dryRun) {
        return true;
    }

    const cooldownMs = Math.max(1, Number(balanceConfig.alertCooldownMinutes) || 30) * 60 * 1000;
    const state = readState(balanceConfig.stateFile);
    const lastLowAlertAt = Number(state.lastLowAlertAt || 0);
    const now = Date.now();
    if (lastLowAlertAt && now - lastLowAlertAt < cooldownMs) {
        const remainingMinutes = Math.ceil((cooldownMs - (now - lastLowAlertAt)) / 60000);
        console.log(`ℹ️ tuZi低余额告警仍在冷却中，剩余约 ${remainingMinutes} 分钟`);
        return false;
    }
    return true;
}

function recordLowAlert(balanceConfig) {
    const state = readState(balanceConfig.stateFile);
    state.lastLowAlertAt = Date.now();
    writeState(balanceConfig.stateFile, state);
}

async function fetchTuZiSelf(tuziConfig, balanceConfig) {
    const baseUrl = tuziConfig.baseUrl || 'https://api.tu-zi.com';
    const accessToken = balanceConfig.accessToken || tuziConfig.apiKey || configLoader.getTuZiApiKey();
    if (!accessToken) {
        throw new Error('tuZi余额访问令牌未配置，请检查 config/secret.json 中的 tuZiBalance.accessToken');
    }

    const agent = tuziConfig.proxy ? new HttpsProxyAgent(tuziConfig.proxy) : undefined;
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
    };
    if (balanceConfig.newApiUser) {
        headers['New-Api-User'] = String(balanceConfig.newApiUser);
    }

    const response = await fetch(`${baseUrl}/api/user/self`, {
        method: 'GET',
        headers,
        agent,
        timeout: 30000
    });

    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`tuZi余额查询失败: HTTP ${response.status} ${responseText.slice(0, 300)}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(responseText);
    } catch (error) {
        throw new Error(`tuZi余额响应不是JSON: ${responseText.slice(0, 300)}`);
    }
    if (parsed && parsed.success === false) {
        throw new Error(`tuZi余额查询失败: ${parsed.message || 'success=false'}`);
    }
    if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
        throw new Error(`tuZi余额查询失败: code=${parsed.code} ${parsed.message || ''}`.trim());
    }
    return parsed;
}

function pickUserPayload(data) {
    if (data && typeof data === 'object') {
        if (data.data && typeof data.data === 'object') {
            return data.data;
        }
        if (data.user && typeof data.user === 'object') {
            return data.user;
        }
    }
    return data;
}

function pickFirstFiniteNumber(payload, keys) {
    for (const key of keys) {
        const value = payload?.[key];
        const numberValue = Number(value);
        if (Number.isFinite(numberValue)) {
            return numberValue;
        }
    }
    return NaN;
}

function extractBalance(userPayload) {
    const quota = pickFirstFiniteNumber(userPayload, ['quota', 'remain_quota', 'remaining_quota']);
    const balance = pickFirstFiniteNumber(userPayload, ['balance', 'money', 'amount', 'credit', 'remain_balance']);

    if (Number.isFinite(balance)) {
        return { quota: Number.isFinite(quota) ? quota : NaN, balance };
    }

    if (Number.isFinite(quota)) {
        return { quota, balance: quota / 500000 };
    }

    return { quota: NaN, balance: NaN };
}

async function runBalanceCheck(options = {}) {
    const mergedOptions = {
        dryRun: false,
        lowOnly: false,
        force: false,
        reason: '',
        ...options
    };

    const config = configLoader.getConfig();
    const balanceConfig = getBalanceConfig(config);
    if (!balanceConfig.enabled) {
        console.log('ℹ️ tuZi余额检查已禁用');
        return { notified: false, skipped: true };
    }

    const tuziConfig = getTuZiConfig(config);
    const webhookUrl = config.wechatWork?.webhookUrl || '';
    const userPayload = pickUserPayload(await fetchTuZiSelf(tuziConfig, balanceConfig));
    const { quota, balance } = extractBalance(userPayload);
    const threshold = Number.isFinite(balanceConfig.lowBalanceThreshold)
        ? balanceConfig.lowBalanceThreshold
        : 5;
    const isLow = Number.isFinite(balance) && balance <= threshold;
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    console.log(`tuZi checkedAt=${now}, quota=${Number.isFinite(quota) ? quota : 'unknown'}, balance=${formatNumber(balance)}, threshold=${threshold}`);

    if (mergedOptions.lowOnly && !isLow) {
        console.log('ℹ️ 余额未低于阈值，跳过低余额告警');
        return { notified: false, isLow, balance, quota, threshold };
    }

    if (!balanceConfig.notifyOnSuccess && !isLow) {
        console.log('ℹ️ 余额未低于阈值，且 notifyOnSuccess=false，跳过企微通知');
        return { notified: false, isLow, balance, quota, threshold };
    }

    const content = [
        isLow ? '⚠️ tuZi API余额不足' : '✅ tuZi API余额日报',
        '',
        `> 余额: ${formatNumber(balance)} 元`,
        `> quota: ${Number.isFinite(quota) ? quota : 'unknown'}`,
        `> 告警阈值: ${formatNumber(threshold)} 元`,
        mergedOptions.reason ? `> 触发原因: ${String(mergedOptions.reason).slice(0, 500)}` : undefined,
        `> 时间: ${now}`
    ].filter(Boolean).join('\n');

    if (isLow && !shouldSendLowAlert(balanceConfig, mergedOptions)) {
        return { notified: false, isLow, balance, quota, threshold, skippedByCooldown: true };
    }

    if (mergedOptions.dryRun) {
        console.log('--- dry-run notification ---');
        console.log(content);
        return { notified: false, isLow, balance, quota, threshold, dryRun: true };
    }

    const sent = await sendWeChatMarkdown(webhookUrl, content);
    if (sent && isLow) {
        recordLowAlert(balanceConfig);
    }
    console.log(sent ? '✅ tuZi余额通知已发送' : 'ℹ️ tuZi余额通知未发送');
    return { notified: sent, isLow, balance, quota, threshold };
}

async function notifyLowBalanceIfNeeded(reason = '') {
    return runBalanceCheck({
        lowOnly: true,
        reason
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    await runBalanceCheck(options);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`❌ tuZi余额检查失败: ${error.message}`);
        process.exit(1);
    });
}

module.exports = {
    extractBalance,
    formatNumber,
    getBalanceConfig,
    notifyLowBalanceIfNeeded,
    parseArgs,
    runBalanceCheck
};
