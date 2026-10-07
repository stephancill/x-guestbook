import { z } from "zod";
import { secretSchema } from "./schema";

export const runIdSchema = z.string().uuid();
export const runSchema = z.object({
  id: runIdSchema,
  token: secretSchema,
  expiresAt: z.number().int(),
});
export const eventSchema = z
  .object({
    page: z.string().uuid(),
    stage: z.enum(["viewer", "popup", "complete"]),
    type: z.string().min(1).max(80),
    at: z.number().int(),
    data: z.record(z.string().max(100), z.unknown()),
  })
  .strict();
export const eventsSchema = z.object({ events: z.array(eventSchema).min(1).max(20) }).strict();
export const reportSchema = z.object({
  events: z.array(eventSchema.extend({ id: z.number().int(), receivedAt: z.number().int() })),
});
export const contextSchema = z.object({ headers: z.record(z.string(), z.string().nullable()) });
export const probeConfigSchema = z.object({
  origin: z.string().url(),
  hopOrigin: z.string().url(),
});
export const probeModeSchema = z.enum(["manual", "close", "opener", "same-view", "return"]);
