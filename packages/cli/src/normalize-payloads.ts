const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeSample = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    const decoded: unknown = JSON.parse(value);
    return decoded;
  } catch {
    return value;
  }
};

const normalizeSide = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...("sample" in value ? { sample: decodeSample(value.sample) } : {}),
    ...("before" in value ? { before: decodeSample(value.before) } : {}),
  };
};

const normalizeMessage = (value: unknown): unknown => {
  if (!isRecord(value) || !isRecord(value.payload)) return value;
  const payload = value.payload;
  return {
    ...value,
    payload: {
      ...payload,
      ...("request" in payload ? { request: normalizeSide(payload.request) } : {}),
      ...("response" in payload ? { response: normalizeSide(payload.response) } : {}),
    },
  };
};

export const normalizePayloadSamples = (body: Record<string, unknown>): Record<string, unknown> => {
  if (!Array.isArray(body.flows)) return body;
  return {
    ...body,
    flows: body.flows.map((flow: unknown) => {
      if (!isRecord(flow) || !Array.isArray(flow.messages)) return flow;
      return { ...flow, messages: flow.messages.map(normalizeMessage) };
    }),
  };
};
