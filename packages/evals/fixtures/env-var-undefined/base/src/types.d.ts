import "express";

declare module "express-serve-static-core" {
  interface Request {
    /** The request body's bytes, kept by the JSON parser in app.ts. */
    rawBody?: Buffer;
  }
}
