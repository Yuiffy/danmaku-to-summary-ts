import { editorialMediaIO } from './editorialMedia';
test('production adapter measures actual audio and applies only the requested OP attenuation', async () => {
    const run = jest.fn(async () => ({ stderr: '{"input_i":"-27.1","input_tp":"-4.2"}' }));
    const io = editorialMediaIO({}, 'ffprobe', run);
    await expect(io.measureAudio('final.mp4', 4, 7)).resolves.toEqual({ integrated: -27.1, truePeak: -4.2 });
    expect(run.mock.calls[0][0]).toEqual(expect.arrayContaining(['-ss', '4', '-t', '3', 'loudnorm=I=-23:TP=-1.5:LRA=7:print_format=json']));
    await io.render('op.mp4', 'part.mp4', 0, 3, { width: 1920, height: 1080, duration: 30, audio: true }, -14);
    expect(run.mock.calls[1][0]).toContain('volume=-14dB,aresample=48000,apad');
});
