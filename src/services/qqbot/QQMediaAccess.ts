/** Server configuration contains authenticated user digests, never mutable nicknames. */
export interface QQMediaAccess { mediaOperators?: string[] }
export const QQ_MEDIA_OPERATOR_LIMITS = { intervalMs: 10000, userWindowImages: 50, userDailyLimit: 150,
  maxConcurrent: 4, maxUserQueue: 8 } as const;
export const qqMediaOperator = (access: QQMediaAccess, user: string) => access.mediaOperators?.includes(user) === true;
export function validateQQMediaAccess(access: QQMediaAccess): void {
  if (access.mediaOperators !== undefined && (!Array.isArray(access.mediaOperators) || access.mediaOperators.length > 20 ||
    new Set(access.mediaOperators).size !== access.mediaOperators.length || access.mediaOperators.some(user => typeof user !== 'string' || !/^[a-f0-9]{64}$/u.test(user)))) {
    throw new Error('Invalid QQ media operators');
  }
}
