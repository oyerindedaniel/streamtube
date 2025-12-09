import { rateLimitConfigs } from "../lib/rate-limiter";

export const uploadRouteConfig = {
  config: {
    rateLimit: {
      max: rateLimitConfigs.upload.max,
      timeWindow: rateLimitConfigs.upload.timeWindow,
    },
  },
};

export const apiRouteConfig = {
  config: {
    rateLimit: {
      max: rateLimitConfigs.api.max,
      timeWindow: rateLimitConfigs.api.timeWindow,
    },
  },
};
