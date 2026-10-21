import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12).max(256);
const token = z.string().min(20).max(200);

export const signupBody = z.object({ email, password });
export const loginBody = z.object({ email, password: z.string().min(1).max(256) });
export const tokenBody = z.object({ token });
export const resetRequestBody = z.object({ email });
export const resetBody = z.object({ token, password });
export const mfaVerifyBody = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    recoveryCode: z.string().min(10).max(20).optional(),
  })
  .refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), { message: 'provide code or recoveryCode' });
export const googleCallbackQuery = z.object({ code: z.string().min(1), state: z.string().min(1) });
