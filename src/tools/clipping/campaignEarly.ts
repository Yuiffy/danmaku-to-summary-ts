import * as path from 'node:path';
import { createRequire } from 'node:module';

const localRequire = createRequire(path.resolve('package.json'));

export async function main(args = process.argv.slice(2)): Promise<void> {
    if (args.includes('--help')) {
        console.log('campaign:early [--room ID --date YYYY_MM_DD] [--trigger | --loop]\nManual live snapshot: --room ID --date YYYY_MM_DD --snapshot --note "game segment ended" --trigger\nDefault: preview completed title-switch batches. --trigger enqueues; --loop watches enabled campaign rooms every 30s.');
        return;
    }
    const room = args.includes('--room') ? args[args.indexOf('--room') + 1] : undefined;
    if (!process.env.NODE_ENV) Object.assign(process.env, { NODE_ENV: 'production' });
    const date = args.includes('--date') ? args[args.indexOf('--date') + 1] : undefined;
    if (date && !/^\d{4}_\d{2}_\d{2}$/u.test(date)) throw new Error('Expected --date YYYY_MM_DD');
    if (args.includes('--trigger') && !room) throw new Error('Manual trigger requires --room');
    if (args.includes('--snapshot')) {
        const note = args.includes('--note') ? args[args.indexOf('--note') + 1] : '';
        if (!room || !date || !note?.trim() || !args.includes('--trigger') || args.includes('--loop')) throw new Error('Manual snapshot requires --room, --date, --note and --trigger; no --loop');
        const config = localRequire('./src/scripts/config-loader').getConfig();
        const result = await localRequire('./src/scripts/campaign_snapshot.ts').triggerCampaignSnapshot(config, room, date, note);
        console.log(JSON.stringify(result));
        return;
    }
    const runtime = localRequire('./src/scripts/campaign_early.ts');
    const policy = localRequire('./src/core/media/CampaignEarlyPolicy.ts');
    const loader = localRequire('./src/scripts/config-loader');
    if (args.includes('--loop')) console.log('Campaign early trigger watching configured recording rooms; poll=30s');
    const day = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 10).replace(/-/gu, '_');
    do {
        try {
            loader.clearCache();
            const config = loader.getConfig(), now = Date.now();
            const rows = runtime.discoverCampaignRecordings(config, date ? [date] : [day(now - 86400000), day(now)]);
            const batches = policy.selectEarlyBatches(config.ownStreamClips?.campaigns || [], rows, now, room);
            for (const batch of batches) {
                if (!args.includes('--trigger') && !args.includes('--loop')) console.log(JSON.stringify(batch));
                else {
                    const receipt = runtime.admitEarlyBatch(batch);
                    if (!args.includes('--loop') || receipt.status !== 'already_reserved') console.log(JSON.stringify(receipt));
                }
            }
            if (!batches.length && !args.includes('--loop')) console.log('No completed eligible title-switch batch; active recordings are not admitted.');
        } catch (error) {
            if (!args.includes('--loop')) throw error;
            console.error(error);
        }
        if (args.includes('--loop')) await new Promise(resolve => setTimeout(resolve, 30000));
    } while (args.includes('--loop'));
}

if (process.argv[1] && /campaignEarly\.(?:ts|js)$/u.test(process.argv[1])) main().catch(error => { console.error(error); process.exitCode = 1; });
