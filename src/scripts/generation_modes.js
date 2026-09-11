'use strict';
if (require.main === module) process.env.NODE_ENV ||= 'production';
const loader = require('./config-loader');

function describeModes(config, roomId) {
    const ai = config.ai || {};
    const modes = ai.generationModes || {};
    if (roomId) {
        const room = ai.roomSettings?.[String(roomId)];
        if (!room) throw new Error(`Unknown room: ${roomId}`);
        return { roomId: String(roomId), mode: room.generationMode || null,
            label: modes[room.generationMode]?.label || null,
            wordLimit: room.wordLimit ?? ai.defaultWordLimit ?? 100,
            fullLiveContextExperiment: room.fullLiveContextExperiment || null,
            imageGeneration: room.imageGeneration || ai.comic?.imageGeneration || null };
    }
    return Object.entries(modes).map(([id, mode]) => ({ id, label: mode.label || id,
        description: mode.description || '', extends: mode.extends || null, experimental: mode.experimental === true,
        rooms: Object.entries(ai.roomSettings || {}).filter(([, room]) => room.generationMode === id).map(([id]) => id) }));
}

if (require.main === module) {
    try {
        console.log(JSON.stringify(describeModes(loader.getConfig(), process.argv[2]), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { describeModes };
