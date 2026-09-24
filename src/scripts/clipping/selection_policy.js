'use strict';

// Room exclusions add to global restrictions, never remove them.
function resolveSelectionPolicy(policy = {}, roomId = null) {
    const room = policy.roomOverrides?.[String(roomId || '')] || {};
    return { ...policy, excludedCategories: [...new Set([
        ...(policy.excludedCategories || []), ...(room.excludedCategories || [])
    ].map(value => String(value).trim()).filter(Boolean))] };
}
module.exports = { resolveSelectionPolicy };
