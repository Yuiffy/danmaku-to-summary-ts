#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const configLoader = require('../config-loader');
const asrBackends = require('./asr_backends');

const DOCTOR_SCRIPT = path.join(__dirname, '..', 'python', 'fun_asr_nano_vllm_doctor.py');

function main() {
    if (!fs.existsSync(DOCTOR_SCRIPT)) {
        console.error(`ASR vLLM doctor script not found: ${DOCTOR_SCRIPT}`);
        process.exit(1);
    }

    const jsonOutput = process.argv.slice(2).includes('--json');
    const originalConsoleLog = console.log;
    let config;
    if (jsonOutput) {
        console.log = (...args) => console.error(...args);
    }
    try {
        config = configLoader.getConfig();
    } finally {
        console.log = originalConsoleLog;
    }
    const asrConfig = asrBackends.getAsrConfig(config);
    const backendConfig = asrConfig.fun_asr_nano_vllm || {};
    const pythonCommand = asrBackends.resolvePythonCommand(backendConfig);
    const doctorScript = asrBackends.translatePythonPath(DOCTOR_SCRIPT, backendConfig);
    const args = [...pythonCommand.args, doctorScript, ...process.argv.slice(2)];

    const statusLog = jsonOutput ? console.error : console.log;
    statusLog(`[ASR doctor] python=${pythonCommand.executable}${pythonCommand.args.length ? ` ${pythonCommand.args.join(' ')}` : ''}`);
    const child = spawn(pythonCommand.executable, args, {
        stdio: 'inherit',
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1' }
    });

    child.on('error', (error) => {
        console.error(`[ASR doctor] failed to start python: ${error.message}`);
        process.exit(1);
    });

    child.on('close', (code, signal) => {
        if (signal) {
            console.error(`[ASR doctor] exited by signal ${signal}`);
            process.exit(1);
        }
        process.exit(code || 0);
    });
}

main();
