import http from "node:http";
import { handleEvent } from "./index.js";

const port = Number(process.env.PORT || 9000);

const server = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const result = await handleEvent({
      httpMethod: request.method,
      path: request.url,
      headers: request.headers,
      body: body.toString("base64"),
      isBase64Encoded: true,
    });

    response.statusCode = result?.statusCode || 500;
    for (const [name, value] of Object.entries(result?.headers || {})) {
      response.setHeader(name, value);
    }
    const payload = result?.isBase64Encoded
      ? Buffer.from(result.body || "", "base64")
      : Buffer.from(result?.body || "");
    response.end(payload);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "Gateway request failed", message: error?.message || "Unknown error" }));
  }
});

server.listen(port, "0.0.0.0");
