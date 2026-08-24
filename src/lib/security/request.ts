export function assertSameOrigin(request: Request, expectedPublicUrl: string): void {
  const origin = request.headers.get("origin");
  if (!origin) return;

  const expected = new URL(expectedPublicUrl).origin;
  if (origin !== expected) {
    throw new Error("Request origin is not allowed");
  }
}
