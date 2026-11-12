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
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.status(status).json({ error: err.expose === false ? "Bad request" : err.message });
};
