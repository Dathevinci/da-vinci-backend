import { AnyZodObject, ZodError } from "zod";
import { Request, Response, NextFunction } from "express";

export const validateRequest = (schema: AnyZodObject) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: error.errors,
        });
      } else {
        next(error);
      }
    }
  };
};
