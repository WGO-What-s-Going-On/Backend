export const RECIPIENT_RESOLVER = Symbol('RECIPIENT_RESOLVER');

export interface RecipientResolver {
  postAuthor(postId: string): Promise<string | null>;
}

export class UnavailableRecipientResolver implements RecipientResolver {
  async postAuthor(): Promise<null> {
    // The Post meta endpoint does not currently authorize notification-service.
    return null;
  }
}
