import { ZodTypeAny, ZodError } from "zod";
import { Request, Response, NextFunction } from "express";

export const validateRequest = (schema: ZodTypeAny) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      return next();
    } catch (error: any) {
      if (error instanceof ZodError || error?.issues) {
        res.status(400).json({
          success: false,
          message: "Validation failed",
          errors: error.issues || error.errors,
        });
      } else {
        next(error);
      }
    }
  };
};
