export class RequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return readResponse<T>(response);
}

export async function uploadRaster<T>(path: string, file: File): Promise<T> {
  if (!["image/png", "image/jpeg"].includes(file.type))
    throw new RequestError(
      400,
      "unsupported_file",
      "Choose a PNG or JPEG image. SVG, PDF, and font files are not supported.",
    );
  if (file.size === 0 || file.size > 5 * 1024 * 1024)
    throw new RequestError(
      400,
      "file_size",
      "Choose a nonempty image no larger than 5 MiB.",
    );
  return readResponse<T>(
    await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": file.type },
      body: file,
    }),
  );
}

async function readResponse<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    throw new RequestError(
      response.status,
      value?.error?.code ?? value?.code ?? "REQUEST_FAILED",
      value?.error?.message ??
        value?.message ??
        "We couldn't reach your workspace. Your saved work is still there. Please try again.",
    );
  }
  return value as T;
}

export function displayDate(value: string | null) {
  if (!value) return "Not active yet";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
