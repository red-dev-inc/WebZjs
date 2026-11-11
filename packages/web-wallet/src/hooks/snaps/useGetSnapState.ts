import { useCallback } from 'react';
import { useInvokeSnap } from './useInvokeSnap';

// Single source of truth for the Snap state shape.
export type { LastKnownBalance, SnapState } from '../../types/snap';
import type { SnapState } from '../../types/snap';

export const useGetSnapState = () => {
  const invokeSnap = useInvokeSnap();

  const getSnapState = useCallback(async () => {
    const snapStateHome = (await invokeSnap({
      method: 'getSnapStete',
    })) as unknown as SnapState;
    return snapStateHome;
  }, [invokeSnap]);

  return { getSnapState };
};
