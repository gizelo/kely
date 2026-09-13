import { handleApi } from "@/server/api";

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return handleApi(request, (await context.params).path);
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return handleApi(request, (await context.params).path);
}
