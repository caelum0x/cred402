import type { RenderedMessage, SendResult } from "../types.js";

/**
 * A delivery channel. Implementations transform a RenderedMessage into a
 * channel-native payload and deliver it, returning whether it succeeded.
 *
 * `send` MUST NOT throw for ordinary delivery failures (network errors,
 * non-2xx responses); it should resolve with `{ ok: false, detail }` so the
 * router can apply retry/backoff. Throwing is reserved for programmer errors.
 */
export interface Channel {
  /** Stable identifier used by subscriptions to target this channel. */
  readonly name: string;
  /** Deliver a single rendered message. */
  send(message: RenderedMessage): Promise<SendResult>;
}
