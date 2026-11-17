import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

/** useMutation that toasts errors/success and invalidates the given query keys. */
export function useMutate<TVars, TRes>(
  fn: (v: TVars) => Promise<TRes>,
  opts: { invalidate?: string[][]; success?: string | ((r: TRes) => string); onSuccess?: (r: TRes) => void } = {},
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k })
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success)
      opts.onSuccess?.(r)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  })
}
