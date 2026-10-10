import { invoke, isTauri } from "@tauri-apps/api/core";
export const native = isTauri();
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
function errorFrom(value: unknown): ApiError {
  if (value instanceof ApiError) return value;
  let body: any = value;
  if (typeof value === "string") {
    try {
      body = JSON.parse(value);
    } catch {
      body = { error: { code: "NETWORK", message: value } };
    }
  }
  return new ApiError(
    body?.error?.code ?? "NETWORK",
    body?.error?.message ??
      "Cannot reach your workspace. Your input is preserved.",
  );
}
export async function api<T = any>(
  path: string,
  options: { method?: string; data?: unknown; key?: string } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  try {
    if (native)
      return await invoke<T>("api_request", {
        method,
        path,
        body: options.data ?? null,
        key: options.key ?? null,
      });
    const res = await fetch(path, {
      method,
      credentials: "include",
      headers: {
        ...(options.data !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
      },
      ...(options.data !== undefined
        ? { body: JSON.stringify(options.data) }
        : {}),
    });
    const result = await res.json();
    if (!res.ok) throw errorFrom(result);
    return result as T;
  } catch (e) {
    throw errorFrom(e);
  }
}
export const post = <T = any>(
  path: string,
  data: unknown = {},
  key: string = crypto.randomUUID(),
) => api<T>(path, { method: "POST", data, key });
export async function demoLogin() {
  if (native) await invoke("demo_login");
  else await post("/api/demo/sign-in");
}
export async function signOut() {
  if (native) await invoke("sign_out");
  else await post("/api/sign-out");
  sessionStorage.removeItem("manual-time-draft");
}
export async function openUrl(url: string) {
  if (native) await invoke("open_url", { url });
  else window.open(url, "_blank", "noopener,noreferrer");
}
export async function exportCsv(kind: string) {
  if (native) return invoke("export_csv", { kind });
  const res = await fetch(`/api/v1/exports/${kind}`, {
    credentials: "include",
  });
  if (!res.ok) throw errorFrom(await res.json());
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `running-tab-${kind}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
export function navigate(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
