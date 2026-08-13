const path = require('path');
const { resolveClipOutputRoot } = require('./clip_output_path');

describe('resolveClipOutputRoot', () => {
  const config = {
    outputDirName: 'own_stream_fun_clips',
    archiveSourceRoot: 'E:/EFiles/Evideo/DDTV录播-E',
    activeOutputRoot: 'D:/files/videos/DDTV录播'
  };

  test('maps archived recordings back to the active D drive tree', () => {
    expect(resolveClipOutputRoot(
      'E:/EFiles/Evideo/DDTV录播-E/25788785_岁己SUI/2025_09_23/source.mp4',
      config
    )).toBe(path.resolve(
      'D:/files/videos/DDTV录播/25788785_岁己SUI/2025_09_23/own_stream_fun_clips'
    ));
  });

  test('keeps non-archive recordings beside their source', () => {
    expect(resolveClipOutputRoot('D:/captures/2026_08_13/source.mp4', config)).toBe(
      path.resolve('D:/captures/2026_08_13/own_stream_fun_clips')
    );
  });
});
