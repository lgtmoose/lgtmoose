import { STATUS_CODES } from "node:http";
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
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : 500;
}

/**
 * Last-resort error handler. Client errors keep their status, and their message only when it is
 * marked safe to show; anything else becomes a plain 500 so internals never reach the caller. Express 5 forwards rejected
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
  // Only messages marked safe to show (http-errors and body-parser set `expose` on 4xx errors)
  // reach the caller; anything else gets the standard status text, e.g. "Not Found".
  res
    .status(status)
    .json({ error: err.expose === true ? err.message : (STATUS_CODES[status] ?? "Error") });
};
