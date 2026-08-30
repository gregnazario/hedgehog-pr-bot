import type { Logger } from "./types.ts";

type Sink = (line: string) => void;

function render(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** Wraps log calls in one JSON object per line: {"time","level","message"}. */
export function makeJsonLogger(sink: Sink = (line) => console.log(line)): Logger {
  return {
    log: (...args: unknown[]) =>
      sink(
        JSON.stringify({
          time: new Date().toISOString(),
          level: "info",
          message: args.map(render).join(" "),
        }),
      ),
    error: (...args: unknown[]) =>
      sink(
        JSON.stringify({
          time: new Date().toISOString(),
          level: "error",
          message: args.map(render).join(" "),
        }),
      ),
  };
}
