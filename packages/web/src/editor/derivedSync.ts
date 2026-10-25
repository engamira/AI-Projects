import { useEffect, useRef } from 'react';
import { activeLanguageVersions, derivedSegments, type TestContactDto } from '@cl/shared';
import { api } from '../api';
import { useEditor } from './store';

/**
 * Block conditions split each language into more segments (UAE-en, SA-en, Default-en). Preview needs a made-up test
 * contact for each, so the missing ones are built a moment after the email changes. `onBuilt` runs after contacts were added.
 */
export function useDerivedTestContacts(campaignId: string, enabled: boolean, onBuilt: () => void): void {
  const content = useEditor((s) => s.content);
  const tried = useRef('');
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const a = await api<{ audience: { fields: string[] }; test: TestContactDto[] }>('GET', `/api/campaigns/${campaignId}/audience`);
          const fields = a.audience.fields;
          const lf = content.versioning?.languageField;
          if (content.versioning?.mode !== 'conditions' || !lf || !fields.includes(lf)) return;
          const languages = new Map<string, string>();
          for (const v of activeLanguageVersions(content, fields)) if (v.values[0]) languages.set(v.values[0].toLowerCase(), v.values[0]);
          const have = new Set(a.test.map((c) => c.code.toLowerCase()));
          const { rows } = derivedSegments(content, fields, [...languages.values()]);
          const missing = rows.filter((r) => r.fields.length > 1 && !have.has(r.code.toLowerCase()));
          const signature = missing.map((r) => r.code).join('|');
          if (missing.length === 0 || signature === tried.current) return;
          tried.current = signature;
          const groups = new Map<string, { fields: string[]; rows: string[][] }>();
          for (const r of missing) {
            const g = groups.get(r.fields.join(',')) ?? { fields: r.fields, rows: [] };
            g.rows.push(r.values);
            groups.set(r.fields.join(','), g);
          }
          for (const g of groups.values()) await api('POST', `/api/campaigns/${campaignId}/test-audience`, { mode: 'combos', combos: g });
          onBuilt();
        } catch { /* shown the next time the Segments tab is opened */ }
      })();
    }, 1800);
    return () => clearTimeout(timer);
  }, [content, campaignId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}
