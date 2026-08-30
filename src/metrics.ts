export interface Metrics {
  inc(name: string, labels?: Record<string, string>): void;
  render(): string;
}

const quotedLabels = (labels: Record<string, string>): string =>
  Object.keys(labels)
    .sort()
    .map((key) => `${key}="${labels[key]}"`)
    .join(",");

/** Minimal Prometheus text exposition: counters, gauges, start time. */
export function createMetrics(
  gauges: Record<string, () => number> = {},
  now: () => number = Date.now,
): Metrics {
  const startedAtMs = now();
  const counters = new Map<
    string,
    { name: string; labels: Record<string, string>; value: number }
  >();

  return {
    inc(name, labels = {}) {
      const key = `${name}{${quotedLabels(labels)}}`;
      const current = counters.get(key);
      if (current) current.value += 1;
      else counters.set(key, { name, labels, value: 1 });
    },
    render() {
      const lines: string[] = [
        "# TYPE process_start_time_seconds gauge",
        `process_start_time_seconds ${Math.floor(startedAtMs / 1000)}`,
      ];
      const byName = new Map<string, Array<{ label: string; value: number }>>();
      for (const { name, labels, value } of counters.values()) {
        const samples = byName.get(name) ?? [];
        samples.push({ label: quotedLabels(labels), value });
        byName.set(name, samples);
      }
      for (const [name, samples] of byName) {
        lines.push(`# TYPE ${name} counter`);
        for (const { label, value } of samples) {
          lines.push(label ? `${name}{${label}} ${value}` : `${name} ${value}`);
        }
      }
      for (const [name, read] of Object.entries(gauges)) {
        lines.push(`# TYPE ${name} gauge`, `${name} ${read()}`);
      }
      return `${lines.join("\n")}\n`;
    },
  };
}
