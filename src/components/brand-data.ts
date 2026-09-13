"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BrandView, MemoryInterpretation } from "../shared/brand";
import { request, RequestError } from "./api";

export type RunBrandAction = (action: () => Promise<void>) => Promise<boolean>;
export type BrandData = ReturnType<typeof useBrandData>;

export function useBrandData(
  onError: (error: unknown) => void,
  run: RunBrandAction,
) {
  const [brand, setBrand] = useState<BrandView | null>(null);
  const [loading, setLoading] = useState(true);
  const commandKeys = useRef(new Map<string, string>());
  const reload = useCallback(async () => {
    const next = await request<BrandView>("/api/kely/brand");
    setBrand(next);
    return next;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void request<BrandView>("/api/kely/brand", undefined, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setBrand(next);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [onError]);

  function commandKey(path: string, input: unknown) {
    const signature = JSON.stringify([path, input]);
    let key = commandKeys.current.get(signature);
    if (!key) {
      key = crypto.randomUUID();
      commandKeys.current.set(signature, key);
    }
    return key;
  }

  async function change(work: () => Promise<BrandView>) {
    return run(async () => {
      try {
        setBrand(await work());
      } catch (error) {
        if (error instanceof RequestError && error.status === 409) {
          try {
            await reload();
          } catch {}
        }
        throw error;
      }
    });
  }

  async function remember(text: string): Promise<MemoryInterpretation | null> {
    if (!brand) return null;
    let interpretation: MemoryInterpretation | null = null;
    const input = { text, version: brand.version };
    const success = await change(async () => {
      const result = await request<{
        interpretation: MemoryInterpretation;
        brand: BrandView;
      }>("/api/kely/brand/memory", {
        ...input,
        commandKey: commandKey("memory", input),
      });
      interpretation = result.interpretation;
      return result.brand;
    });
    return success ? interpretation : null;
  }

  return { brand, loading, reload, change, commandKey, remember };
}
