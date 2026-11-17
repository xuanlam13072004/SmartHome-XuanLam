/** An error the global error handler turns into `{ success: false, error: { code, message } }`. */
export type HttpError = Error & { statusCode: number; code: string };

export function httpError(statusCode: number, code: string, message: string): HttpError {
    const error = new Error(message) as HttpError;
    error.statusCode = statusCode;
    error.code = code;
    return error;
}
