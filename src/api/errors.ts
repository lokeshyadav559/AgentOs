/** HTTP error with status, thrown by services and turned into JSON by the API. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
