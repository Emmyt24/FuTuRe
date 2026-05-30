import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getExchangeRate } from '../api/stellar.js';

async function fetchExchangeRate(from, to) {
  return getExchangeRate(from, to);
}

/**
 * Fetches the XLM/USD exchange rate with automatic caching and refetching.
 * Keeps it fresh via rateChange WebSocket events (passed in as `wsMessage`).
 *
 * React Query handles:
 * - Initial fetch on mount
 * - Background refetch every 60s
 * - Refetch on window focus
 * - Automatic retry on failure
 * - Caching for 60s
 *
 * @param {object|null} wsMessage – latest message from useWebSocket's onMessage
 * @returns {{ rate: number|null, loading: boolean, error: Error|null }}
 */
export function useExchangeRate(wsMessage) {
  const queryClient = useQueryClient();
  const { data: rate, isLoading, error } = useQuery({
    queryKey: ['exchangeRate', 'XLM', 'USD'],
    queryFn: () => fetchExchangeRate('XLM', 'USD'),
    staleTime: 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  useEffect(() => {
    if (wsMessage?.type === 'rateChange' && wsMessage.from === 'XLM' && wsMessage.to === 'USD') {
      queryClient.setQueryData(['exchangeRate', 'XLM', 'USD'], wsMessage.rate);
    }
  }, [wsMessage, queryClient]);

  return { rate: rate ?? null, loading: isLoading, error };
}
