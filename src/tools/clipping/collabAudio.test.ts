import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { continuousAudioAudit } from './collabAudio';

describe('continuous collab audio preservation', () => {
    let root: string;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-audio-')); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
    function fixture(duration: number, change?: (buffer: Buffer) => void) {
        const pcm = Buffer.alloc(Math.round(duration * 48000) * 8);
        for (let i = 0; i < pcm.length / 4; i++) pcm.writeFloatLE(.12 * Math.sin(Math.floor(i / 2) * .17), i * 4);
        const calls: string[][] = [];
        const run = async (args: string[]) => {
            calls.push(args);
            const data = Buffer.from(pcm);
            if (calls.length === 2 && change) change(data);
            fs.writeFileSync(args[args.length - 1], data);
        };
        return { audit: continuousAudioAudit(run), calls };
    }
    it('covers a late chunk while decoding output continuously with sample-index trim', async () => {
        const { audit, calls } = fixture(31.25);
        const result = await audit('recorder.flv', 'render.mp4', 7737, .125, 31.25, path.join(root, 'audit'));
        expect(result.status).toBe('passed'); expect(result.checks).toHaveLength(2);
        expect(calls).toHaveLength(2); expect(calls[0]).toContain('-ss'); expect(calls[1]).not.toContain('-ss');
        expect(calls[1]).toContain('aresample=48000,atrim=start_sample=6000:end_sample=1506000,asetpts=PTS-STARTPTS');
        const tail = JSON.parse(fs.readFileSync(path.join(root, 'audit/1-CHECK.json'), 'utf8'));
        expect(tail.offset).toBe(30); expect(tail.correlation).toBeCloseTo(1);
    });
    it('rejects changed dialogue after the first 30 seconds and retains failure evidence', async () => {
        const { audit } = fixture(31, buffer => buffer.fill(0, 30 * 48000 * 8));
        await expect(audit('source', 'output', 0, 0, 31, path.join(root, 'audit'))).rejects.toThrow('original_audio_changed');
        expect(JSON.parse(fs.readFileSync(path.join(root, 'audit/1-CHECK.json'), 'utf8')).status).toBe('failed');
    });
    it('keeps truly silent audio valid without requiring an undefined correlation', async () => {
        const zero = Buffer.alloc(48000 * 8);
        const silent = continuousAudioAudit(async args => { fs.writeFileSync(args[args.length - 1], zero); });
        expect((await silent('source', 'output', 0, 0, 1, path.join(root, 'audit'))).status).toBe('passed');
    });
    it('rejects a truncated track before comparing samples', async () => {
        const audit = continuousAudioAudit(async args => { fs.writeFileSync(args[args.length - 1], Buffer.alloc(8)); });
        await expect(audit('source', 'output', 0, 0, 1, path.join(root, 'audit'))).rejects.toThrow('audio_duration_changed');
    });
});
