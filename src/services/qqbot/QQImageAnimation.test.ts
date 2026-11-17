import * as fs from 'fs';
import * as path from 'path';
import { validateQQGif } from './QQImageAnimation';

test('accepts a large multi-frame GIF when each frame fits the decode budget', async () => {
  const file = path.join(__dirname, 'fixtures', 'multi-frame-large.gif');
  const bytes = fs.readFileSync(file);
  await expect(validateQQGif(bytes, 'image_prepare')).resolves.toBe(bytes);
});
