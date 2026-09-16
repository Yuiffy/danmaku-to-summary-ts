'use strict';

const { parseArgs } = require('node:util');
const { refreshReview } = require('./clipping/own_review_artifacts');

if (require.main === module) {
    const { values } = parseArgs({ options: { plan: { type: 'string' }, notify: { type: 'boolean', default: false } } });
    if (!values.plan) throw new Error('--plan is required; this command refreshes IDs/review only and never rerenders or uploads');
    refreshReview(values.plan, { notify: values.notify }).then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error); process.exitCode = 1; });
}
