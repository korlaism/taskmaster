export class AppError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "AppError";
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Not authorized to perform this action") {
    super(message, "authorization_denied");
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, "not_found");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "conflict");
  }
}
