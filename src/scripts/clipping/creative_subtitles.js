'use strict';
// Creative timeline timestamps round to milliseconds; preserve that contract.

function srtText(cues) {
    const clock = time => { const n = Math.round(time * 1000); return `${String(Math.floor(n / 3600000)).padStart(2, '0')}:${String(Math.floor(n / 60000) % 60).padStart(2, '0')}:${String(Math.floor(n / 1000) % 60).padStart(2, '0')},${String(n % 1000).padStart(3, '0')}`; };
    return cues.map((c, i) => `${i + 1}\n${clock(c.start)} --> ${clock(c.end)}\n${c.text}\n`).join('\n');
}

module.exports = { srtText };
