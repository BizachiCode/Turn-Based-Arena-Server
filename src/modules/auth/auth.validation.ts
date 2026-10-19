// src/modules/auth/auth.validation.ts
// Zod schemas for incoming auth messages (`auth` request, multiplexed by `type`).

import { z } from "zod";
import { strictPayload } from "../../shared/validation.js";

const deviceId = z.string().min(1).max(64).optional();
const userAgent = z.string().max(255).optional();

export const RegisterSchema = z.object({
  type: z.literal("register"),
  email: z.string().email().max(255),
  password: z.string().min(6).max(256),
  username: z.string().min(3).max(32).optional().or(z.literal("").optional()),
  deviceId,
  userAgent,
}).strict();

export const LoginSchema = z.object({
  type: z.literal("login"),
  emailOrUsername: z.string().min(1).max(255),
  password: z.string().min(1).max(256),
  deviceId,
  userAgent,
}).strict();

export const RefreshSchema = z.object({
  type: z.literal("refresh"),
  userId: z.string().min(1).max(64),
  refreshToken: z.string().min(1).max(512),
  deviceId,
  userAgent,
}).strict();

export const LogoutSchema = z.object({
  type: z.literal("logout"),
  userId: z.string().min(1).max(64),
  refreshToken: z.string().min(1).max(512),
  deviceId,
}).strict();

export const GuestSchema = z.object({
  type: z.literal("guest"),
  deviceId,
  userAgent,
}).strict();

/** Undo a pending deletion: same credentials and limits as `login`. */
export const CancelDeletionSchema = strictPayload({
  type: z.literal("cancel_deletion"),
  emailOrUsername: z.string().min(1).max(255),
  password: z.string().min(1).max(256),
  deviceId,
  userAgent,
});

export const AuthMessageSchema = z.discriminatedUnion("type", [
  RegisterSchema,
  LoginSchema,
  RefreshSchema,
  LogoutSchema,
  GuestSchema,
  CancelDeletionSchema,
]);

export type AuthMessage = z.infer<typeof AuthMessageSchema>;
