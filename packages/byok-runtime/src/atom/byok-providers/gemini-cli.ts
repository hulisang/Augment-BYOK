import { spawn } from "child_process";
import { buildAbortSignal, normalizeString } from "../common/http";
import type { ByokStreamEvent } from "./stream-events";

function abortError(signal: AbortSignal): Error {
  const reason = (signal as any).reason;
  const msg = typeof reason === "string" && reason.trim() ? reason.trim() : "Aborted";
  const err: any = new Error(msg);
  err.name = "AbortError";
  return err;
}

function applyTemplate(raw: string, { model, prompt }: { model: string; prompt: string }): string {
  return raw.replaceAll("{{model}}", model).replaceAll("{{prompt}}", prompt);
}

export async function* geminiCliStreamEvents({
  command,
  args,
  model,
  prompt,
  apiKey,
  timeoutMs,
  abortSignal
}: {
  command: string;
  args?: string[];
  model: string;
  prompt: string;
  apiKey?: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): AsyncGenerator<ByokStreamEvent> {
  const cmd = normalizeString(command);
  if (!cmd) throw new Error("gemini_cli command 未配置");
  const m = normalizeString(model);
  if (!m) throw new Error("gemini_cli 缺少 model");
  const p = normalizeString(prompt);
  if (!p) throw new Error("gemini_cli 缺少 prompt");

  const rawArgs = Array.isArray(args) ? args.map((x) => String(x)) : [];
  const hasPromptPlaceholder = rawArgs.some((a) => a.includes("{{prompt}}"));
  const finalArgs = rawArgs.map((a) => applyTemplate(a, { model: m, prompt: p }));
  const signal = buildAbortSignal(timeoutMs, abortSignal);

  const env: NodeJS.ProcessEnv = { ...process.env };
  const key = normalizeString(apiKey);
  if (key) {
    if (!env.GEMINI_API_KEY) env.GEMINI_API_KEY = key;
    if (!env.BYOK_API_KEY) env.BYOK_API_KEY = key;
    if (!env.BYOK_TOKEN) env.BYOK_TOKEN = key;
  }

  const child = spawn(cmd, finalArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
  const outQ: string[] = [];
  let done = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnErr: Error | null = null;
  let notify: (() => void) | null = null;

  const wake = () => {
    if (!notify) return;
    const fn = notify;
    notify = null;
    fn();
  };

  const stderrLimit = 4000;
  let stderr = "";
  child.stderr?.on("data", (buf) => {
    if (stderr.length >= stderrLimit) return;
    stderr += buf.toString("utf8");
  });

  child.stdout?.on("data", (buf) => {
    const chunk = buf.toString("utf8");
    if (chunk) outQ.push(chunk);
    wake();
  });
  child.on("error", (e) => {
    spawnErr = e instanceof Error ? e : new Error(String(e));
    done = true;
    wake();
  });
  child.on("close", (code, sig) => {
    exitCode = code;
    exitSignal = sig;
    done = true;
    wake();
  });

  const onAbort = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    wake();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  if (!hasPromptPlaceholder) {
    try {
      child.stdin?.write(p);
    } catch {
      // ignore
    }
  }
  try {
    child.stdin?.end();
  } catch {
    // ignore
  }

  while (true) {
    while (outQ.length) {
      const t = outQ.shift();
      if (t) yield { kind: "text", text: t };
    }
    if (signal.aborted) throw abortError(signal);
    if (spawnErr) throw spawnErr;
    if (done) break;
    await new Promise<void>((r) => (notify = r));
  }

  while (outQ.length) {
    const t = outQ.shift();
    if (t) yield { kind: "text", text: t };
  }

  if (signal.aborted) throw abortError(signal);
  if (spawnErr) throw spawnErr;
  if (exitCode !== 0) {
    const sig = exitSignal ? ` signal=${exitSignal}` : "";
    const errText = normalizeString(stderr).replace(/\s+/g, " ");
    const errPart = errText ? ` stderr=${errText.slice(0, 200)}` : "";
    throw new Error(`gemini_cli 进程退出: code=${String(exitCode)}${sig}${errPart}`.trim());
  }
}

export async function geminiCliCompleteText(args: Parameters<typeof geminiCliStreamEvents>[0]): Promise<string> {
  let out = "";
  for await (const ev of geminiCliStreamEvents(args)) if (ev.kind === "text") out += ev.text;
  return out;
}

