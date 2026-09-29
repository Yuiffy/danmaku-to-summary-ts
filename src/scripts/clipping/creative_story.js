'use strict';

// Every new draft, including one produced after semantic QA, must pass the
// same structural gate. A repair is a proposal, never an approval.
async function validateStoryDraft(draft, { accept, request, prompt, stage, history }) {
    try { return { draft, timeline: accept(draft) }; }
    catch (error) {
        history.push({ stage, reason: error.message, draft });
        const repaired = await request(stage, 'keep', prompt
            + '\n结构校验失败：' + error.message
            + '\n只修复违反硬约束的部分，保留其余有效编辑。不得删除必留字幕或修改其原话；上次审核意见不能覆盖这些约束。'
            + '\n上次计划：' + JSON.stringify(draft));
        return { draft: repaired, timeline: accept(repaired) };
    }
}

module.exports = { validateStoryDraft };
