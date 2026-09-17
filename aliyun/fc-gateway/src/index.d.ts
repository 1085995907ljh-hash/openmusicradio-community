export interface FcEvent {
  httpMethod?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string; path?: string } };
}

export interface FcResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

export function handleEvent(event: FcEvent | string, fetchImpl?: typeof fetch): Promise<FcResponse>;
export function handler(event: FcEvent | string): Promise<FcResponse>;
