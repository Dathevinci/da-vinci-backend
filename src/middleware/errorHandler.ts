import { Request, Response, NextFunction } from "express";

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Always log the full error server-side...
  console.error("🔥 Error:", err.stack || err.message || err);

  const statusCode = err.status || 500;
  const isProd = process.env.NODE_ENV === "production";

  // ...but never leak internal messages/stack traces to clients in production.
  // A thrown error with an explicit status is a deliberate, user-safe message;
  // an unexpected 500 gets a generic message so we don't reveal ORM/internal detail.
  const message = err.status ? (err.message || "Request failed") : (isProd ? "Something went wrong" : (err.message || "Something went wrong"));

  res.status(statusCode).json({
    success: false,
    message,
    error: isProd ? undefined : (err.stack || String(err)),
  });
};
