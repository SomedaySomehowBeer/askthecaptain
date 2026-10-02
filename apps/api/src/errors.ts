/** An error the person can be told about, with the status it deserves. Anything else is a 500 and
 *  is not described to the client. */
export class HttpError extends Error {
	/** The request field the error is about, when naming it helps the person fix it. */
	readonly status: number; readonly code: string; readonly field?: string;
	/** More of the answer, for a refusal that carries what the client needs next (a reversal's fresh preview). */
	readonly body?: Record<string, unknown>;
	constructor(status: number, code: string, message: string, field?: string, body?: Record<string, unknown>) {
		super(message); this.status = status; this.code = code; this.name = 'HttpError'; if (field !== undefined) this.field = field; if (body !== undefined) this.body = body;
	}
}
export const unauthorised = (message = 'sign in to continue') => new HttpError(401, 'unauthorised', message);
export const forbidden = (message = 'you are not allowed to do that') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'not found') => new HttpError(404, 'not_found', message);
export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
