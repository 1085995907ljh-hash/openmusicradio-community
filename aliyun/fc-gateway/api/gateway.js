import { handleEvent } from "../src/index.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const route = url.searchParams.get("route");
    const result = await handleEvent({
      httpMethod: request.method,
      path: route === null ? url.pathname : `/${route.replace(/^\/+/, "")}`,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    return new Response(
      result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body,
      { status: result.statusCode, headers: result.headers },
    );
  },
};
