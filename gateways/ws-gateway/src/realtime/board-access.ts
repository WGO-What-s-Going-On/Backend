export interface BoardAccessContext {
  boardId: string;
  userId: string;
}

export interface BoardAccessAuthorizer {
  canJoin(context: BoardAccessContext): Promise<boolean>;
}

export class UnavailableBoardAccessAuthorizer implements BoardAccessAuthorizer {
  async canJoin(_context: BoardAccessContext): Promise<boolean> {
    return false;
  }
}
