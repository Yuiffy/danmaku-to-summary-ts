#!/usr/bin/env node

const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const configLoader = require('./config-loader');

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
        notifyOnSuccess: config.ai?.tuZiBalance?.notifyOnSuccess !== false
    };
}

async function sendWeChatMarkdown(webhookUrl, content) {
    if (!webhookUrl) {
        console.warn('⚠️ 未配置企业微信 webhookUrl，跳过余额通知');
        return false;
    }

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { content }
        }),
        timeout: 10000
    });

    if (!response.ok) {
        throw new Error(`企业微信请求失败: HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result.errcode !== 0) {
        throw new Error(`企业微信返回错误: ${result.errcode} ${result.errmsg || ''}`.trim());
    }
    return true;
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

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const config = configLoader.getConfig();
    const balanceConfig = getBalanceConfig(config);
    if (!balanceConfig.enabled) {
        console.log('ℹ️ tuZi余额检查已禁用');
        return;
    }

    const tuziConfig = getTuZiConfig(config);
    const webhookUrl = config.wechatWork?.webhookUrl || '';
    const userPayload = pickUserPayload(await fetchTuZiSelf(tuziConfig, balanceConfig));
    const quota = Number(userPayload?.quota);
    const balance = quota / 500000;
    const threshold = Number.isFinite(balanceConfig.lowBalanceThreshold)
        ? balanceConfig.lowBalanceThreshold
        : 5;
    const isLow = Number.isFinite(balance) && balance < threshold;
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    console.log(`tuZi quota=${Number.isFinite(quota) ? quota : 'unknown'}, balance=${formatNumber(balance)}, threshold=${threshold}`);

    if (!balanceConfig.notifyOnSuccess && !isLow) {
        console.log('ℹ️ 余额未低于阈值，且 notifyOnSuccess=false，跳过企微通知');
        return;
    }

    const title = isLow ? '⚠️ tuZi API余额不足' : '✅ tuZi API余额日报';
    const content = [
        title,
        '',
        `> 余额: ${formatNumber(balance)} 元`,
        `> quota: ${Number.isFinite(quota) ? quota : 'unknown'}`,
        `> 告警阈值: ${formatNumber(threshold)} 元`,
        `> 时间: ${now}`
    ].join('\n');

    if (dryRun) {
        console.log('--- dry-run notification ---');
        console.log(content);
        return;
    }

    await sendWeChatMarkdown(webhookUrl, content);
    console.log('✅ tuZi余额通知已发送');
}

main().catch(error => {
    console.error(`❌ tuZi余额检查失败: ${error.message}`);
    process.exit(1);
});
