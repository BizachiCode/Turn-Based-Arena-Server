import { Schema } from "@colyseus/schema";
import { AuthenticatedRoom } from "../../shared/rooms/authenticated-room.js";
import type { RateLimiter } from "../../shared/security/rate-limiter.js";
import type { MailService } from "./mail.service.js";
import {
  MailClaimAllSchema,
  MailClaimSchema,
  MailDeleteReadSchema,
  MailDeleteSchema,
  MailListSchema,
  MailReadSchema,
  MailSummarySchema,
} from "./mail.validation.js";

export class MailState extends Schema {}

export type MailRoomDeps = {
  mail: MailService;
  queryLimiter: RateLimiter;
  mutationLimiter: RateLimiter;
};

/** Room `mail`: the player's inbox (list, badge counts, read, claim rewards, delete). */
export class MailRoom extends AuthenticatedRoom<MailState, MailRoomDeps> {
  state = new MailState();

  onCreate(): void {
    const { mail, queryLimiter, mutationLimiter } = this.deps;

    this.handleAuthenticatedRequest("mail/list", {
      schema: MailListSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => mail.getInbox(userId),
    });

    this.handleAuthenticatedRequest("mail/summary", {
      schema: MailSummarySchema,
      rateLimit: queryLimiter,
      handle: ({ userId }) => mail.summary(userId),
    });

    this.handleAuthenticatedRequest("mail/read", {
      schema: MailReadSchema,
      rateLimit: queryLimiter,
      handle: ({ userId }, req) => mail.read(userId, req.mailIds),
    });

    this.handleAuthenticatedRequest("mail/claim", {
      schema: MailClaimSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => mail.claim(userId, req.mailId),
    });

    this.handleAuthenticatedRequest("mail/claimAll", {
      schema: MailClaimAllSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }) => mail.claimAll(userId),
    });

    this.handleAuthenticatedRequest("mail/delete", {
      schema: MailDeleteSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }, req) => mail.delete(userId, req.mailIds),
    });

    this.handleAuthenticatedRequest("mail/deleteRead", {
      schema: MailDeleteReadSchema,
      rateLimit: mutationLimiter,
      handle: ({ userId }) => mail.deleteRead(userId),
    });
  }
}
