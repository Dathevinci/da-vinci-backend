import { Request, Response, NextFunction } from "express";

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  console.error("🔥 Error:", err.message || err);

  const statusCode = err.status || 500;
  const message = err.message || "Something went wrong";

  res.status(statusCode).json({
    success: false,
    message,
    error: process.env.NODE_ENV === "development" ? err.stack || err : undefined,
  });
};
