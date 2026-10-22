import { useEffect, useRef } from 'react';

/** Runs an effect once per mount, even under React Strict Mode's double invocation (single-use tokens). */
export function useOnce(effect: () => void) {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    effect();
  }, []);
}
