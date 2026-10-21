import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createBrowserRouter, type DataRouter, RouterProvider } from "react-router";
import { ApiError } from "./api/client";
import { routes } from "./routes";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retrying a 404 or 403 won't help; retry network hiccups and 5xx once
        retry: (failures, error) =>
          failures < 1 && !(error instanceof ApiError && error.status < 500),
      },
    },
  });
}

// Tests pass their own router and query client
export function App({ router, queryClient }: { router?: DataRouter; queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const [appRouter] = useState(() => router ?? createBrowserRouter(routes));

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={appRouter} />
    </QueryClientProvider>
  );
}
