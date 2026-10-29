import { opAudioGain, parseLoudness } from './editorialAudio';
test('a loud OP is attenuated relative to the actual dialogue without changing dialogue', () => {
    expect(opAudioGain({ integrated: -27, truePeak: -9 }, { integrated: -12, truePeak: -.5 })).toBe(-16);
    expect(opAudioGain({ integrated: -15, truePeak: -3 }, { integrated: -20, truePeak: -4 })).toBe(0);
    expect(opAudioGain({ integrated: -15, truePeak: -3 }, { integrated: -20, truePeak: 0 })).toBe(-1.5);
});
test('measurements reject silence and missing reports instead of assuming a fixed OP gain', () => {
    expect(parseLoudness('log\n{"input_i":"-27.1","input_tp":"-4.2"}')).toEqual({ integrated: -27.1, truePeak: -4.2 });
    expect(() => parseLoudness('')).toThrow();
    expect(() => parseLoudness('{"input_i":"-inf","input_tp":"-inf"}')).toThrow();
});
