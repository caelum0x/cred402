/** Error thrown by the Cred402 SDK when the API returns a failure envelope. */
export class Cred402Error extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "Cred402Error";
  }

  get isNotFound(): boolean {
    return this.code === "not_found";
  }
  get isValidation(): boolean {
    return this.code === "validation_error";
  }
  get isUnauthorized(): boolean {
    return this.code === "unauthorized" || this.code === "forbidden";
  }
  get isRateLimited(): boolean {
    return this.code === "rate_limited";
  }
}
