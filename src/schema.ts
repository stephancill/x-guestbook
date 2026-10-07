import { z } from "zod";

export const roomSchema = z.string().regex(/^[a-z0-9-]{1,32}$/);
export const DEFAULT_ROOM = "poc-1";
export const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const AUTH_RETURN_KEY = "guestbook.auth-return";
export const authReturnSchema = z
  .object({
    state: secretSchema,
    path: z.string().regex(/^\/$|^\/(?:r|play)\/[a-z0-9-]{1,32}$/),
    expiresAt: z.number().int(),
  })
  .strict();
export const appConfigSchema = z.object({
  room: roomSchema,
  embedToken: secretSchema,
});

export const profileSchema = z.object({
  id: z.string().regex(/^\d+$/),
  username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  name: z.string().max(100),
  avatar: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "pbs.twimg.com";
    })
    .nullable(),
});
export const entrySchema = profileSchema.extend({
  message: z.string().max(280),
  signedAt: z.number().int(),
});
export const bookSchema = z.object({
  entries: z.array(entrySchema),
  configured: z.boolean(),
});
export const signatureSchema = z.object({ message: z.string().trim().max(280) }).strict();
export const attemptSchema = z.object({ state: secretSchema, pollToken: secretSchema }).strict();
export const authorizeSchema = z
  .object({ state: secretSchema, launchToken: secretSchema })
  .strict();
export const startSchema = attemptSchema.extend({
  loginUrl: z.string().url(),
  expiresAt: z.number().int(),
});
export const pollSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    phase: z.enum(["pending", "authorizing", "exchanging"]),
  }),
  z.object({ status: z.literal("failed"), error: z.string() }),
  z.object({ status: z.literal("complete"), sessionToken: secretSchema, user: profileSchema }),
]);
