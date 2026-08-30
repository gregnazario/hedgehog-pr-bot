import { appendIgnore, findingFingerprint } from "./memory.ts";
import { isHedgehogLogin } from "./signals.ts";
import type { ReviewJob } from "./types.ts";

export interface IgnoreClient {
  getReviewComment?(fullName: string, commentId: number): Promise<ReviewCommentLike>;
  reactToReviewComment?(fullName: string, commentId: number, content: string): Promise<unknown>;
  listUnresolvedHedgehogThreads?(fullName: string, number: number): Promise<IgnoreThread[]>;
  resolveReviewThread?(threadId: string): Promise<unknown>;
}

export interface ReviewCommentLike {
  id: number;
  path?: string;
  body?: string;
  user?: { login?: string };
}

export interface IgnoreThread {
  commentId: number;
  threadId: string;
}

export interface IgnoreConfig {
  botLogin: string;
  memoryPath: string;
}

/**
 * Handles a `/ignore` reply under a hedgehog review comment: stores the
 * finding fingerprint so future passes drop it, resolves the thread, and
 * acknowledges the reply with 👍.
 */
export async function applyIgnoreJob(
  client: IgnoreClient,
  job: ReviewJob,
  config: IgnoreConfig,
  logger: { error?(...args: unknown[]): void } = console,
): Promise<void> {
  const replyToCommentId = job.replyToCommentId;
  if (!replyToCommentId || typeof client.getReviewComment !== "function") return;
  try {
    const root = await client.getReviewComment(job.fullName, replyToCommentId);
    if (!root || !isHedgehogLogin(root.user?.login, config.botLogin)) return;
    const stored = await appendIgnore(
      config.memoryPath,
      findingFingerprint({ path: root.path, body: root.body }),
    );
    if (typeof client.listUnresolvedHedgehogThreads === "function") {
      const threads = await client.listUnresolvedHedgehogThreads(job.fullName, job.number);
      const thread = threads.find((entry) => entry.commentId === replyToCommentId);
      if (thread && typeof client.resolveReviewThread === "function") {
        await client.resolveReviewThread(thread.threadId);
      }
    }
    if (stored && job.triggerCommentId) {
      await client.reactToReviewComment?.(job.fullName, job.triggerCommentId, "+1");
    }
  } catch (error) {
    logger.error?.(`Could not apply /ignore for ${job.key}: ${(error as Error).message}`);
  }
}
