export type Severity = "Critical" | "High" | "Medium" | "Low";
export type Side = "LEFT" | "RIGHT";
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type EnvSource = Record<string, string | undefined>;

export interface ModelSpec {
  provider: string;
  model: string;
  thinking: string;
  label: string;
}

export interface ReviewConfig {
  author: string;
  authors: string[];
  botLogin: string;
  /** File that persists /ignore fingerprints; empty disables the memory. */
  memoryPath?: string;
  /** Wall-clock cap for one model run; protects the serial queue. */
  piTimeoutMs?: number;
  /** Replaces PI_MODELS for diffs above LARGE_DIFF_THRESHOLD. */
  largeModels?: ModelSpec[];
  /** Bytes of touched-file contents embedded in the bundle; 0 disables. */
  fileContextBytes?: number;
  /** Second model pass that verifies Critical/High findings. */
  verifyFindings?: boolean;
  /** Optional URL notified with each review result; empty disables. */
  notifyWebhook?: string;
  /** Payload shape for NOTIFY_WEBHOOK: generic JSON or Slack text. */
  notifyWebhookFormat?: "json" | "slack";
  maxDiffChars: number;
  models: ModelSpec[];
  fingerprint: string;
}

export interface PullRequestRef {
  fullName: string;
  number: number;
}

export interface ReviewJob extends PullRequestRef {
  key: string;
  installationId: number;
  force: boolean;
  headSha?: string;
  /** Set for /review comments so the trigger can be acknowledged. */
  triggerCommentId?: number;
  /** Check run created at enqueue time; adopted by the worker when it starts. */
  checkRunId?: number;
  /** "ignore" jobs mute a finding; "describe" jobs draft a PR description. */
  kind?: "review" | "ignore" | "describe";
  /** For "ignore" jobs: the hedgehog comment the /ignore reply targets. */
  replyToCommentId?: number;
}

export interface GitHubUser {
  login?: string;
  type?: string;
}

export interface GitHubLabel {
  name?: string;
}

export interface PullRequest {
  number: number;
  state: string;
  draft?: boolean;
  title?: string;
  body?: string;
  user?: GitHubUser;
  head: { sha: string; ref?: string };
  base?: { ref?: string };
  labels?: (string | GitHubLabel)[];
}

export interface PullRequestReview {
  id: number;
  user?: GitHubUser;
  state: string;
  body?: string;
}

export interface IssueReaction {
  id: number;
  content?: string;
  user?: GitHubUser;
}

export interface InlineComment {
  path: string;
  line: number;
  side: Side;
  body: string;
}

export interface ReviewSubmission {
  commitId?: string;
  body?: string;
  event?: ReviewEvent;
  comments?: InlineComment[];
}

export interface SingleCommentSubmission {
  commitId?: string;
  path: string;
  line?: number;
  side?: Side;
  body: string;
}

export interface NewCheckRun {
  headSha?: string;
  name: string;
  status: string;
  title?: string;
  summary?: string;
}

export interface CheckRunRecord {
  id: number;
  name?: string;
  status?: string;
  started_at?: string;
}

export interface CheckRunUpdate {
  status?: string;
  conclusion?: string;
  title?: string;
  summary?: string;
}

export interface CheckOutcome {
  conclusion: string;
  title: string;
  summary: string;
}

export interface Finding {
  severity: Severity;
  path: string;
  line: number;
  side: Side;
  body: string;
  modelLabel?: string;
  start_line?: unknown;
}

export interface StillApplies {
  id: number;
  path?: string;
  line?: number;
  side?: Side;
  severity?: Severity;
  body?: string;
}

export interface ParsedReview {
  summary: string;
  walkthrough?: string;
  findings: Finding[];
  addressedCommentIds: number[];
  stillApplies: StillApplies[];
}

export interface HedgehogThread {
  commentId: number;
  threadId: string;
  path: string;
  line: number;
  side: Side;
  severity: Severity;
  body: string;
  alreadyReplied?: boolean;
}

export type ReviewResult =
  | { status: "skipped_closed" }
  | { status: "skipped_draft" }
  | { status: "skipped_author" }
  | { status: "skipped_current"; headSha: string }
  | {
      status: "reviewed";
      headSha: string;
      event: ReviewEvent;
      severities: Severity[];
    };

// ---- Client capability interfaces ----
// The reviewer and progress flows probe for optional capabilities with
// `typeof client.method === "function"`. These interfaces mirror exactly which
// methods are required versus probed, so the mock clients in tests type-check
// against the same contract the production GitHubClient satisfies.

export interface ReviewerClient {
  getPullRequest(fullName: string, number: number): Promise<PullRequest>;
  getPullRequestDiff(fullName: string, number: number): Promise<string>;
  listPullRequestReviews(fullName: string, number: number): Promise<PullRequestReview[]>;
  createPullRequestReview(
    fullName: string,
    number: number,
    payload: ReviewSubmission,
  ): Promise<{ id?: number } | null | undefined>;
  listUnresolvedHedgehogThreads?(fullName: string, number: number): Promise<HedgehogThread[]>;
  getFileContents?(fullName: string, path: string, ref: string): Promise<string>;
  createPullRequestReviewComment?(
    fullName: string,
    number: number,
    payload: SingleCommentSubmission,
  ): Promise<unknown>;
  updatePullRequestReview?(
    fullName: string,
    number: number,
    reviewId: number,
    body: string,
  ): Promise<unknown>;
  createPullRequestReviewCommentReply?(
    fullName: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<unknown>;
  resolveReviewThread?(threadId: string): Promise<unknown>;
  dismissPullRequestReview?(
    fullName: string,
    number: number,
    reviewId: number,
    message: string,
  ): Promise<unknown>;
  updateCheckRun?(fullName: string, checkRunId: number, payload: CheckRunUpdate): Promise<unknown>;
  deleteIssueReaction?(fullName: string, number: number, reactionId: number): Promise<unknown>;
}

export interface FinishProgressClient {
  deleteIssueReaction?(fullName: string, number: number, reactionId: number): Promise<unknown>;
  updateCheckRun?(fullName: string, checkRunId: number, payload: CheckRunUpdate): Promise<unknown>;
}

export interface StartProgressClient extends FinishProgressClient {
  listIssueReactions?(fullName: string, number: number): Promise<IssueReaction[]>;
  createIssueReaction?(
    fullName: string,
    number: number,
    content: string,
  ): Promise<{ id?: number } | null | undefined>;
  createCheckRun(
    fullName: string,
    payload: NewCheckRun,
  ): Promise<{ id?: number } | null | undefined>;
}

export interface ProgressClient extends StartProgressClient {
  getPullRequest(fullName: string, number: number): Promise<PullRequest>;
  getFileContents?(fullName: string, path: string, ref: string): Promise<string>;
  listIssueLabels?(fullName: string, number: number): Promise<(string | GitHubLabel)[]>;
  listPullRequestReviews?(fullName: string, number: number): Promise<PullRequestReview[]>;
}

export interface ReviewComment {
  id: number;
  path?: string;
  line?: number | null;
  side?: string | null;
  body?: string;
  user?: GitHubUser;
  in_reply_to_id?: number;
}

/** Used by the server to acknowledge /review trigger comments. */
export interface AckClient {
  reactToIssueComment?(fullName: string, commentId: number, content: string): Promise<unknown>;
}

/** Used by /describe jobs to draft pull-request descriptions. */
export interface DescribeClient {
  getPullRequest(fullName: string, number: number): Promise<PullRequest>;
  getPullRequestDiff(fullName: string, number: number): Promise<string>;
  createIssueComment(fullName: string, number: number, body: string): Promise<unknown>;
}

/** Used by /ignore jobs to mute findings and resolve threads. */
export interface IgnoreClient {
  getReviewComment?(
    fullName: string,
    commentId: number,
  ): Promise<{
    id: number;
    path?: string;
    line?: number | null;
    side?: string | null;
    body?: string;
    user?: { login?: string };
    in_reply_to_id?: number;
  }>;
  reactToReviewComment?(fullName: string, commentId: number, content: string): Promise<unknown>;
}

export type AppClient = ReviewerClient & ProgressClient & AckClient & IgnoreClient & DescribeClient;

export interface TokenProvider {
  get(installationId: number): Promise<string>;
}
