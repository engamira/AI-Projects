import { useEffect, useState } from 'react';
import type { BrandProfileDto, BrandResponse, PaletteId } from '@cl/shared';
import { api } from '../api';

type Profiles = Record<PaletteId, BrandProfileDto>;
let cache: Profiles | null = null;
const listeners = new Set<(p: Profiles) => void>();

export async function refreshBrand(): Promise<Profiles> {
  const r = await api<BrandResponse>('GET', '/api/brand');
  cache = r.profiles;
  listeners.forEach((l) => l(r.profiles));
  return r.profiles;
}

/** The latest shared header and footer of each template. Loads once and refreshes after Brand settings change. */
export function useBrand(): Profiles | null {
  const [profiles, setProfiles] = useState<Profiles | null>(cache);
  useEffect(() => {
    listeners.add(setProfiles);
    refreshBrand().catch(() => undefined); // always check for a newer version when the editor opens
    return () => { listeners.delete(setProfiles); };
  }, []);
  return profiles;
}
