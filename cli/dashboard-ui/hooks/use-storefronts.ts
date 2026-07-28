import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_ASO_COUNTRY, apiGet } from "../app-helpers";

const STOREFRONT_STORAGE_KEY = "aso-dashboard:storefront";

export type Storefront = {
  country: string;
  name: string;
  isDefault: boolean;
};

type StorefrontsPayload = {
  storefronts: Storefront[];
  defaultCountry: string;
};

function readStoredCountry(): string {
  if (typeof window === "undefined") return DEFAULT_ASO_COUNTRY;
  try {
    const stored = localStorage.getItem(STOREFRONT_STORAGE_KEY)?.trim();
    return stored ? stored.toUpperCase() : DEFAULT_ASO_COUNTRY;
  } catch {
    return DEFAULT_ASO_COUNTRY;
  }
}

/**
 * Owns the selected storefront and the list of storefronts the server has
 * enabled (ASO_SUPPORTED_COUNTRIES).
 *
 * The persisted storefront is used immediately, without waiting for the list,
 * so the dashboard's first load is not delayed by a round trip. If that
 * storefront is no longer enabled the data routes answer 400 and this hook
 * switches to an enabled one, which triggers a reload.
 */
export function useStorefronts() {
  const [storefronts, setStorefronts] = useState<Storefront[]>([]);
  const [country, setCountryState] = useState<string>(() => readStoredCountry());
  const [storefrontsError, setStorefrontsError] = useState("");
  const countryRef = useRef(country);

  useEffect(() => {
    countryRef.current = country;
  }, [country]);

  const setCountry = useCallback((next: string) => {
    const normalized = next.trim().toUpperCase();
    if (!normalized) return;
    setCountryState(normalized);
    try {
      localStorage.setItem(STOREFRONT_STORAGE_KEY, normalized);
    } catch {
      // no-op
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void apiGet<StorefrontsPayload>("/api/aso/storefronts")
      .then((payload) => {
        if (cancelled) return;
        const list = payload.storefronts ?? [];
        setStorefronts(list);
        const fallback = payload.defaultCountry || DEFAULT_ASO_COUNTRY;
        if (!list.some((entry) => entry.country === countryRef.current)) {
          setCountry(list.length > 0 ? list[0].country : fallback);
        }
      })
      .catch(() => {
        if (cancelled) return;
        // An older server has no /api/aso/storefronts route. Fall back to the
        // default storefront alone, which is exactly the pre-selector behaviour.
        setStorefronts([
          {
            country: DEFAULT_ASO_COUNTRY,
            name: DEFAULT_ASO_COUNTRY,
            isDefault: true,
          },
        ]);
        setCountry(DEFAULT_ASO_COUNTRY);
        setStorefrontsError("Could not load storefronts");
      });
    return () => {
      cancelled = true;
    };
  }, [setCountry]);

  return {
    storefronts,
    country,
    setCountry,
    storefrontsError,
    hasMultipleStorefronts: storefronts.length > 1,
  };
}
