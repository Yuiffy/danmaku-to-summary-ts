import type * as SDK from '@tencent-connect/qqbot-nodejs';

// The SDK exports ESM only. Preserve native import across this project's CommonJS compilation.
// This fixed expression never includes configuration or message data.
const nativeImport = new Function('return import("@tencent-connect/qqbot-nodejs")') as () => Promise<typeof SDK>;
export const loadQQSdk = () => nativeImport();
