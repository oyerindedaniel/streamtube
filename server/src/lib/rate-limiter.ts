import {
  RATE_LIMIT_UPLOAD_MAX,
  RATE_LIMIT_UPLOAD_WINDOW_MS,
  RATE_LIMIT_API_MAX,
  RATE_LIMIT_API_WINDOW_MS,
} from "./constants";

export const rateLimitConfigs = {
  upload: {
    max: RATE_LIMIT_UPLOAD_MAX,
    timeWindow: RATE_LIMIT_UPLOAD_WINDOW_MS,
  },
  api: {
    max: RATE_LIMIT_API_MAX,
    timeWindow: RATE_LIMIT_API_WINDOW_MS,
  },
};
