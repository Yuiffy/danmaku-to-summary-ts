'use strict';
require('../workflow-runtime').loadWorkflow('clipping/precisionBundle').main(process.argv.slice(2))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
