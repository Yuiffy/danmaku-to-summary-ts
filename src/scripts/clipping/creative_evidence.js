'use strict';
const fs = require('fs');
const path = require('path');

/** Resource-scheduled capture and contact sheets shared by planning and final review. */
function createCreativeEvidence({ scratch, topic, withMedia, mediaConfig }) {
    const capture = async (mediaPath, times, prefix) => withMedia(async profile => {
        const files = [];
        for (const [index, time] of times.entries()) {
            const file = path.join(scratch, `${prefix}-${index}.jpg`);
            await topic.runFfmpeg(['-y', '-ss', String(time), '-i', mediaPath, '-frames:v', '1', '-vf', 'scale=960:-2', file], mediaConfig(profile));
            if (!fs.existsSync(file) || fs.statSync(file).size < 4) throw new Error('Missing creative evidence frame');
            files.push(file);
        }
        return files;
    });
    const strips = async (files, prefix) => {
        const sharp = require('sharp'), output = [];
        const dimensions = await sharp(files[0]).metadata(), frameHeight = Math.round(640 * dimensions.height / dimensions.width);
        for (let i = 0; i < files.length; i += 3) {
            const inputs = await Promise.all(files.slice(i, i + 3).map(file => sharp(file).resize(640, frameHeight, { fit: 'contain' }).toBuffer()));
            const file = path.join(scratch, `${prefix}-${i / 3}.jpg`);
            await sharp({ create: { width: 1920, height: frameHeight, channels: 3, background: '#16161b' } })
                .composite(inputs.map((input, index) => ({ input, left: index * 640, top: 0 }))).jpeg({ quality: 88 }).toFile(file);
            output.push(file);
        }
        return output;
    };
    const contactPages = async (files, labels, prefix) => {
        if (files.length <= 7) return files;
        const sharp = require('sharp'), pages = [], height = (await sharp(files[0]).metadata()).height;
        for (let i = 0; i < files.length; i += 4) {
            const rows = files.slice(i, i + 4), overlays = [];
            for (const [j, file] of rows.entries()) {
                const top = j * (height + 28);
                overlays.push({ input: Buffer.from(`<svg width="1920" height="28"><text x="12" y="21" fill="white" font-family="Arial" font-size="20">${labels[i + j]}</text></svg>`), left: 0, top });
                overlays.push({ input: file, left: 0, top: top + 28 });
            }
            const output = path.join(scratch, `${prefix}-${pages.length}.jpg`);
            await sharp({ create: { width: 1920, height: rows.length * (height + 28), channels: 3, background: '#16161b' } })
                .composite(overlays).jpeg({ quality: 88 }).toFile(output);
            pages.push(output);
        }
        return pages;
    };
    return { capture, strips, contactPages };
}

module.exports = { createCreativeEvidence };
