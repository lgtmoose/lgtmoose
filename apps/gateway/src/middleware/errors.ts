import type { ErrorRequestHandler, RequestHandler } from "express";

export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};

/** Errors that carry an HTTP status, such as body-parser's 413 and 400. */
interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  expose?: boolean;
}

/** An error's status if it's a real 4xx/5xx integer, else 500; res.status() throws on bad values. */
function httpStatus(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 400 && (value as number) <= 599
    ? (value as number)
    : 500;
}

/**
 * Last-resort error handler. Client errors keep their status and message; anything else becomes a
 * plain 500 so stack traces and internals never reach the caller. Express 5 forwards rejected
 * promises from async handlers here automatically.
 */
export const errorHandler: ErrorRequestHandler = (err: HttpError, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = httpStatus(err.status ?? err.statusCode);
  if (status >= 500) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.status(status).json({ error: err.expose === false ? "Bad request" : err.message });
};
