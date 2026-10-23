import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runQuestionAgent } from './QuestionAgent';
import { QuestionCorpus } from './QuestionCorpus';
import { formatQuestionRecord } from './QuestionPolicy';

it('can search SC text first, then expand that exact evidence to answer who sent it without losing its identity in the record', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sc-question-'));
  try {
    const folder = path.join(directory, '2026_06_17');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'stream.xml'), '<i><BililiveRecorderRecordInfo start_time="2026-06-17T22:35:56.486+08:00" />' +
      '<d p="8000,1,25,0,1781714956486,0,1,0" user="邻居">无关消息</d>' +
      '<sc ts="8089.015" user="L1f3n0w0v3R710w_" uid="288811455">躺在床上莫名又会想</sc></i>');
    const request = { roomId: '100', uid: '2', question: '躺在床上莫名又会想是谁发的' };
    const signal = new AbortController().signal;
    const corpus = new QuestionCorpus({ enabled: true, providerConfigPath: path.join(directory, 'unused.json'), recordingRoots: { '100': [directory] } }, request, signal);
    let turn = 0, selected = '';
    const result = await runQuestionAgent(request, signal, corpus, async input => {
      turn++;
      if (turn === 1) return { content: null, tool_calls: [{ id: 'sc_search', type: 'function', function: { name: 'search_recordings',
        arguments: JSON.stringify({ terms: ['躺在床上莫名又会想'], kind: 'danmaku', date: '2026-06-17' }) } }] };
      const last = [...input.messages].reverse().find(message => message.content?.includes('untrustedRecordingEvidence'))!;
      const evidence = JSON.parse(last.content!).untrustedRecordingEvidence;
      if (turn === 2) {
        expect(evidence.hits).toHaveLength(1);
        selected = evidence.hits[0].evidenceId;
        return { content: JSON.stringify({ action: 'context', rankedEvidenceIds: [selected], evidenceId: selected }) };
      }
      expect(evidence.hit).toMatchObject({ senderName: 'L1f3n0w0v3R710w_', senderUid: '288811455', messageType: 'superchat' });
      expect(evidence.context.find((cue: { evidenceId: string }) => cue.evidenceId === selected)).toMatchObject({ senderUid: '288811455' });
      return { content: JSON.stringify({ action: 'answer', certainty: 'supported', rankedEvidenceIds: [selected], evidenceIds: [selected],
        answer: '这条SC由L1f3n0w0v3R710w_发送。', shortAnswer: '这条是SC，已查到发送者。' }) };
    });
    expect(turn).toBe(3);
    expect(result.source).toMatchObject({ senderName: 'L1f3n0w0v3R710w_', senderUid: '288811455' });
    const record = formatQuestionRecord({ request, result });
    expect(record).toContain('观众SC');
    expect(record).toContain('UID 288811455');
    expect(record).toContain('2026-06-18 00:50:45');
    expect(record).not.toContain(directory);
    await corpus.close();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
