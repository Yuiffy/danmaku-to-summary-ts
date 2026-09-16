const fs = require('fs');
const { config, budget, context } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { runStage } = require('../../src/scripts/workflow-runtime').loadWorkflow('clipping/stage');
runStage(config, budget, context, 'facts', [], async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
    return { text: 'complete', meta: { attempts: [{ provider: config.provider, model: config.model,
        apiModeUsed: config.apiMode, reasoningEffortSent: config.reasoningEffort }] } };
}).then(() => console.log('admitted')).catch(error => {
    if (!/budget exhausted/.test(error.message)) { console.error(error); process.exitCode = 1; }
    else console.log('blocked');
});
