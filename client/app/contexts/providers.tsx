"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultShouldDehydrateQuery } from "@tanstack/react-query";
import SuperJSON from "superjson";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { ReactNode } from "react";
import { SocketProvider } from "./socket-context";
import { VideoPlayerProvider } from "./video-player-context";
import { useUploadCleanup } from "@/hooks/use-upload-cleanup";

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, we usually want to set some default staleTime
        // above 0 to avoid refetching immediately on the client
        staleTime: 30 * 1000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      dehydrate: {
        serializeData: SuperJSON.serialize,
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) ||
          query.state.status === "pending",
      },
      hydrate: {
        deserializeData: SuperJSON.deserialize,
      },
    },
  });

let clientQueryClientSingleton: QueryClient | undefined = undefined;
const getQueryClient = () => {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return createQueryClient();
  }
  // Browser: use singleton pattern to keep the same query client
  clientQueryClientSingleton ??= createQueryClient();

  return clientQueryClientSingleton;
};

export function Providers({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();

  useUploadCleanup();

  return (
    <QueryClientProvider client={queryClient}>
      <SocketProvider>
        <VideoPlayerProvider>{children}</VideoPlayerProvider>
      </SocketProvider>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
