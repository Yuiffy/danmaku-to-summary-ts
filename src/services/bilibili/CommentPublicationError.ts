import { AppError } from '../../core/errors/AppError';

export type CommentPublicationOutcome = 'not_sent' | 'rejected' | 'unknown';

/** Transport failure is not evidence that a write was rejected by the platform. */
export class CommentPublicationError extends AppError {
  constructor(message: string, public readonly publicationOutcome: CommentPublicationOutcome,
    code = 'API_ERROR', statusCode = 500) { super(message, code, statusCode); }
}

export function commentPublicationOutcome(error: unknown): CommentPublicationOutcome {
  const outcome = (error as Partial<CommentPublicationError> | undefined)?.publicationOutcome;
  return outcome === 'not_sent' || outcome === 'rejected' ? outcome : 'unknown';
}
