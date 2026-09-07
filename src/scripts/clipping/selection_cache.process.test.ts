const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

describe('cross-process selection attempt ownership', () => {
  test.each(['success', 'failure', 'pending', 'invalid', 'incomplete', 'cache-write-failed', 'missing-outcome', 'owner-crash'])
    ('shares a joined attempt without another submission: %s', async mode => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-process-'));
      const children = [];
      const start = role => {
        const child = fork(path.resolve(__dirname, '../../..', 'tests/fixtures/selection-cache-worker.cjs'), [directory, role, mode], {
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_OPTIONS: '' }
        });
        const events = [];
        let stderr = '';
        child.stderr.on('data', data => { stderr += data; });
        child.stdout.resume();
        child.on('message', message => events.push(message));
        const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stderr })));
        const worker = { child, events, closed,
          wait: event => {
            const existing = events.find(message => message.event === event);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolve, reject) => {
              const clean = () => { child.off('message', listener); child.off('close', onClose); child.off('error', onError); };
              const listener = message => { if (message.event === event) { clean(); resolve(message); } };
              const onClose = () => { clean(); reject(new Error(`Worker closed before ${event}: ${stderr}`)); };
              const onError = error => { clean(); reject(error); };
              child.on('message', listener); child.once('close', onClose); child.once('error', onError);
            });
          }
        };
        children.push(worker);
        return worker;
      };
      const timeout = setTimeout(() => children.forEach(({ child }) => child.kill()), 12000);
      try {
        const owner = start('owner');
        await owner.wait('generated');
        const first = start('waiter');
        const second = start('waiter');
        await Promise.all([first.wait('waiting'), second.wait('waiting')]);
        if (mode === 'owner-crash') owner.child.kill();
        else owner.child.send({ finish: true });
        const closed = await Promise.all(children.map(worker => worker.closed));
        expect(closed.slice(1).every(result => result.code === 0)).toBe(true);
        expect(children.flatMap(worker => worker.events).filter(event => event.event === 'generated')).toHaveLength(1);
        const terminal = worker => worker.events.find(event => ['resolved', 'rejected'].includes(event.event));
        const ownerResult = terminal(owner);
        for (const waiter of [first, second]) {
          const result = terminal(waiter);
          expect(result.diagnostics.requests).toHaveLength(1);
          const diagnostic = result.diagnostics.requests[0];
          expect(diagnostic).toMatchObject({ promptTokens: 0, completionTokens: 0, requestCount: 0 });
          if (['missing-outcome', 'owner-crash'].includes(mode)) {
            expect(result).toMatchObject({ event: 'rejected', error: { code: 'SELECTION_OUTCOME_UNKNOWN', outcomeUnknown: true,
              selectionCache: { joined: true } } });
            expect(diagnostic.reusedGeneration.usageUnknown).toBe(true);
          } else {
            expect(result.event).toBe(ownerResult.event);
            expect(diagnostic.reusedGeneration.knownUsage).toMatchObject({ promptTokens: 100, completionTokens: 25 });
            if (result.event === 'resolved') expect(result.result.text).toBe(ownerResult.result.text);
            else {
              expect(result.error.message).toBe(ownerResult.error.message);
              expect(result.error.attempts).toEqual(ownerResult.error.attempts);
            }
          }
        }
        if (mode !== 'owner-crash') {
          expect(ownerResult.diagnostics.requests[0]).toMatchObject({ requestCount: 1,
            knownUsage: { promptTokens: 100, completionTokens: 25 } });
          if (mode === 'pending') expect(ownerResult.diagnostics.requests[0].promptTokens).toBeNull();
        }
        if (mode !== 'success') {
          expect(fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/u.test(name))).toEqual([]);
          const fresh = start('fresh');
          await fresh.closed;
          expect(fresh.events.filter(event => event.event === 'generated')).toHaveLength(1);
          expect(terminal(fresh).event).toBe('resolved');
        }
      } finally {
        clearTimeout(timeout);
        children.forEach(({ child }) => { if (child.exitCode == null && !child.killed) child.kill(); });
        await Promise.all(children.map(worker => worker.closed));
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }, 15000);
});
