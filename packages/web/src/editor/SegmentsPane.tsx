import { useState } from 'react';
import { defaultEmailName, languageEmailOf, parseCell, variantCode, versionName, segmentKey, type TestAudienceResult } from '@cl/shared';
import { api, errorText } from '../api';
import { useSession } from '../session';
import { SegmentFieldPicker } from '../components/SegmentFieldPicker';
import { useEditor } from './store';
import { plainLabel, useSegmentData, type Cell, type Mode, type SegmentRow } from './segmentData';

export { modeOf } from './segmentData';

// The Segments tab: how the versions are built, who the campaign is for, the test audience, and which email each segment receives.

/** Add a field of your own (for example "Interest") while setting up a campaign; it is then available to every campaign. */
function AddFieldInline({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [type, setType] = useState('text');
  const [error, setError] = useState('');
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try { await api('POST', '/api/contact-fields', { label, type }); setLabel(''); setOpen(false); onAdded(); } catch (err) { setError(errorText(err)); }
  }
  if (!open) return <p><button type="button" className="link" onClick={() => setOpen(true)}>＋ Add a field of my own</button></p>;
  return (
    <form className="inline-form" onSubmit={(e) => void add(e)} aria-label="Add a field of my own">
      <div><label htmlFor="inline-field-name">New field name</label><input id="inline-field-name" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Interest" /></div>
      <div><label htmlFor="inline-field-type">Kind of values</label>
        <select id="inline-field-type" value={type} onChange={(e) => setType(e.target.value)}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="boolean">Yes / no</option></select></div>
      <div className="inline-form-actions"><button className="primary" disabled={!label.trim()}>Add field</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
      {error && <p className="error" role="alert" style={{ flexBasis: '100%' }}>{error}</p>}
    </form>
  );
}

export function SegmentsPane({ campaignId, canEdit, refreshKey, onOpenVersion, onContinue }: {
  campaignId: string; canEdit: boolean; refreshKey: number; onOpenVersion: () => void; onContinue: () => void;
}) {
  const { can } = useSession();
  const d = useSegmentData(campaignId, refreshKey);
  const { content, info, load, mode, chosen, chosenFields, test, languageField, routes, copies, languages, unused, found, rowList, tooMany } = d;
  const setVersioning = useEditor((s) => s.setVersioning);
  const setRoute = useEditor((s) => s.setRoute);
  const addVariant = useEditor((s) => s.addVariant);
  const addLanguageVersion = useEditor((s) => s.addLanguageVersion);
  const removeVariant = useEditor((s) => s.removeVariant);
  const setEditing = useEditor((s) => s.setEditing);

  const [values, setValues] = useState<Record<string, string>>({});
  const [languagesText, setLanguagesText] = useState('');
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [typedLanguage, setTypedLanguage] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const guarded = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try { await fn(); await load(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const keepRoutes = Object.keys(routes).length ? { routes } : {};

  function confirmFieldChange(next: string[]): boolean {
    const hasVersions = copies.length > 0;
    const parts = [test.length ? 'removes the test audience made for this campaign' : '', hasVersions ? 'stops using the segment versions you wrote (they are kept, and used again if you choose the same fields)' : ''].filter(Boolean);
    return next.join() === chosen.join() || parts.length === 0 || window.confirm(`Changing the fields ${parts.join(' and ')}. Continue?`);
  }
  function changeFields(next: string[]) {
    if (!confirmFieldChange(next)) return;
    void guarded(async () => {
      await api('PUT', `/api/campaigns/${campaignId}/audience`, { fields: next });
      if (mode === 'conditions') setVersioning({ mode: 'conditions', ...(next[0] ? { languageField: next[0] } : {}), ...keepRoutes });
    });
  }
  function chooseMode(m: Mode) {
    if (m === mode) return;
    if (m === 'copies') { setVersioning({ mode: 'copies', ...keepRoutes }); return; }
    // one email per language: the campaign is segmented by exactly one field, normally Language
    if (chosen.length === 1) { setVersioning({ mode: 'conditions', languageField: chosen[0]!, ...keepRoutes }); return; }
    const first = info?.available.some((f) => f.key === 'language') ? 'language' : info?.available[0]?.key;
    if (!first || !confirmFieldChange([first])) return;
    void guarded(async () => {
      await api('PUT', `/api/campaigns/${campaignId}/audience`, { fields: [first] });
      setVersioning({ mode: 'conditions', languageField: first, ...keepRoutes });
    });
  }

  const build = (m: 'sheet' | 'values') => guarded(async () => {
    const vals = mode === 'conditions' && languageField
      ? { [languageField]: languagesText.split(',').map((s) => s.trim()).filter(Boolean) }
      : Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.split(',').map((s) => s.trim()).filter(Boolean)]));
    const r = await api<TestAudienceResult>('POST', `/api/campaigns/${campaignId}/test-audience`, { mode: m, values: m === 'values' ? vals : undefined });
    setNote(r.added === 0 ? 'Nothing new to add: those combinations are already in the test audience.' : `Built ${r.added} test contact${r.added === 1 ? '' : 's'}${r.alreadyThere ? ` (${r.alreadyThere} already there)` : ''}.`);
    if (m === 'values') { setValues({}); setLanguagesText(''); }
  });

  /** A language or segment added here gets its made-up test contact at once, so it appears in the test audience and in Preview as. */
  async function addTestFor(vals: Record<string, string[]>) {
    try {
      await api('POST', `/api/campaigns/${campaignId}/test-audience`, { mode: 'values', values: vals });
      await load();
    } catch (e) { setError(errorText(e)); }
  }

  function created(id: string | null) {
    if (!id) setError('Could not add that version: it already exists, or the campaign has the most versions allowed.');
    else onOpenVersion();
  }
  function createCopy(vals: Cell[]) { setError(''); created(addVariant(chosen, vals, copyFrom || null)); }
  function createLanguage(value: string, from: string = copyFrom) { setError(''); if (languageField) created(addLanguageVersion(languageField, value, from || null)); }
  async function createTypedLanguage() {
    const names = typedLanguage.split(',').map((s) => s.trim()).filter(Boolean); // several languages may be typed, separated by commas
    if (names.length === 0 || !languageField) return;
    setError('');
    setBusy(true);
    try {
      await api('POST', `/api/campaigns/${campaignId}/test-audience`, { mode: 'values', values: { [languageField]: names } });
      await load();
    } catch (e) { setError(errorText(e)); setBusy(false); return; } // nothing is created when the test contacts could not be built
    setBusy(false);
    setTypedLanguage('');
    let made = 0;
    for (const n of names) if (!languageEmailOf(content, languageField, n) && addLanguageVersion(languageField, n, copyFrom || null)) made++;
    setNote(`Added ${names.join(', ')}: test contacts built${made ? ` and ${made} language email${made === 1 ? '' : 's'} created` : ' (the emails already existed)'}. Open one with Edit.`);
  }
  async function createTyped() {
    const vals: Cell[] = [];
    for (const f of chosenFields) {
      const cell = parseCell(f, typed[f.key] ?? '');
      if ('error' in cell) { setError(cell.error + '.'); return; }
      vals.push(cell.value);
    }
    const raw = Object.fromEntries(chosenFields.map((f) => [f.key, [(typed[f.key] ?? '').trim()]]));
    setTyped({});
    await addTestFor(raw);
    createCopy(vals);
  }

  const copyFromOptions = (
    <>
      <option value="">{mode === 'conditions' ? `The ${defaultEmailName(content)} email` : 'The Default email'}</option>
      {languages.map((v) => <option key={v.id} value={v.id}>The {versionName(v)} email</option>)}
      {copies.map((v) => <option key={v.id} value={v.id}>The {variantCode(v)} version</option>)}
    </>
  );

  const emailOptions = (
    <>
      <option value="default">{mode === 'conditions' ? `${defaultEmailName(content)} email` : 'Default email'}</option>
      {languages.map((v) => <option key={v.id} value={v.id}>{versionName(v)} email</option>)}
      {copies.map((v) => <option key={v.id} value={v.id}>{variantCode(v)} version</option>)}
    </>
  );

  const emailCell = (r: SegmentRow) => {
    const auto = d.resolve(r, d.withoutRoutes);
    const now = d.resolve(r, content);
    return (
      <td>
        <select aria-label={`Email for ${r.code}`} disabled={!canEdit} value={d.routeOf(r)} onChange={(e) => setRoute(d.routeKey(r), e.target.value || null)}>
          <option value="">Automatic · {d.nameOf(auto.variant?.id)}</option>
          {emailOptions}
        </select>
        <div className="muted small">{now.shown} of {now.total} blocks shown{d.routeOf(r) ? ' · set by you' : ''}</div>
      </td>
    );
  };

  const noChoice = !mode;
  const lang = languageField ? plainLabel(chosenFields[0]?.label ?? languageField) : 'Language';

  return (
    <div className="audience-pane">
      {(error || d.loadError) && <p className="error" role="alert">{error || d.loadError}</p>}
      {!canEdit && <p className="muted small">Only a Builder can change this, and only while the campaign is a draft.</p>}

      <section className="seg-panel tint-choice" aria-labelledby="seg-choice-title" data-testid="segment-versions">
        <h2 id="seg-choice-title">How will you build the versions?</h2>
        <fieldset className="build-mode" disabled={!canEdit || !info}>
          <legend className="sr-only">How will you build the versions?</legend>
          <label className="check"><input type="radio" name="build-mode" checked={mode === 'conditions'} onChange={() => chooseMode('conditions')} />
            <span><strong>One email per language, with show/hide conditions.</strong> Each language gets one email holding every block its segments need. On each block you choose who sees it, and the segments are updated for you.</span></label>
          <label className="check"><input type="radio" name="build-mode" checked={mode === 'copies'} onChange={() => chooseMode('copies')} />
            <span><strong>A separate copy for each segment.</strong> You choose the fields that split the audience (up to 10). A segment's version starts as a copy of the Default and you edit its blocks version by version.</span></label>
        </fieldset>
        {noChoice && <p className="muted">Choose one to continue. Contacts get the email written for their segment, else their language's email, else the Default email.</p>}
      </section>

      {!noChoice && (
        <section className="seg-panel tint-who" aria-labelledby="seg-who-title">
          <h2 id="seg-who-title">Who this campaign is for</h2>
          {mode === 'conditions'
            ? <p className="muted small">Choose the field that holds the language. Each language gets its own email; the rules on its blocks split it into more segments.</p>
            : <p className="muted small">Choose the fields that split this campaign's audience into segments, for example Country and Language. A segment is named from its values, such as UAE-en or EG-ar, and those names appear in Preview and test sends.</p>}
          <SegmentFieldPicker available={info?.available ?? []} chosen={chosen} max={mode === 'conditions' ? 1 : undefined} disabled={!canEdit || busy} onChange={changeFields} idPrefix="campaign-seg" />
          {mode === 'copies' && canEdit && can('audience.manage') && <AddFieldInline onAdded={() => void guarded(async () => undefined)} />}
          {chosen.length === 0 && <p className="muted">Pick {mode === 'conditions' ? 'the language field' : 'at least one field'} to continue.</p>}
        </section>
      )}

      {!noChoice && chosen.length > 0 && (
        <section className="seg-panel tint-test" aria-labelledby="seg-test-title" data-testid="test-audience">
          <h2 id="seg-test-title">Test audience</h2>
          <p className="muted small">Made-up contacts to try this email against. They are not part of your contact list, they are never emailed, and they use made-up addresses ending in .invalid. Pick one in the Preview tab with "Preview as".</p>
          {note && <p className="ok" role="status">{note}</p>}
          {canEdit && (
            <>
              {mode === 'conditions' ? (
                <div className="map-grid">
                  <label>{lang === 'Language' ? 'Languages' : lang} <span className="muted small">(separate several with commas, for example en, ar)</span>
                    <input aria-label="Languages" value={languagesText} placeholder="en, ar" onChange={(e) => setLanguagesText(e.target.value)} />
                  </label>
                </div>
              ) : (
                <>
                  <p className="small">Type the values for each field. Every value you list for one field is combined with the values you list for the others, and anything already in the test audience is kept. For example Country UAE with Language en, ar builds UAE-en and UAE-ar.</p>
                  <div className="map-grid">
                    {chosenFields.map((f) => (
                      <label key={f.key}>{plainLabel(f.label)} <span className="muted small">(separate several with commas)</span>
                        <input aria-label={`Values for ${plainLabel(f.label)}`} value={values[f.key] ?? ''} placeholder={f.type === 'text' ? 'e.g. UAE' : ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                      </label>
                    ))}
                  </div>
                </>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                <div style={{ flex: '0 0 auto' }}>
                  <button type="button" className="primary" disabled={busy || (mode === 'conditions' ? !languagesText.trim() : chosenFields.some((f) => !(values[f.key] ?? '').trim()))} onClick={() => void build('values')}>Build test audience</button>
                </div>
                <div style={{ flex: '0 0 auto' }}><button type="button" disabled={busy} onClick={() => void build('sheet')}>Build from my contact list</button></div>
                {test.length > 0 && <button type="button" disabled={busy} onClick={() => { if (window.confirm('Remove every test contact of this campaign?')) void guarded(async () => { await api('DELETE', `/api/campaigns/${campaignId}/test-audience`); }); }}>Remove all</button>}
              </div>
            </>
          )}
          {test.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Segment</th><th>Test contact</th><th>Made-up address</th><th></th></tr></thead>
                <tbody>{test.map((c) => <tr key={c.id}><td><strong>{c.code}</strong></td><td>{String(c.data.first_name ?? '')} {String(c.data.last_name ?? '')}</td><td className="muted small">{c.email}</td><td>{canEdit && <button type="button" className="link danger" aria-label={`Remove test contact ${c.code}`} disabled={busy} onClick={() => void guarded(async () => { await api('DELETE', `/api/campaigns/${campaignId}/test-audience/${c.id}`); })}>Remove</button>}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {!noChoice && chosen.length > 0 && (
        <section className="seg-panel tint-map" aria-labelledby="seg-map-title">
          <h2 id="seg-map-title">Which email each segment receives</h2>
          <p className="muted small">Every segment is listed with the email it gets. It is chosen for you (a copy written for the segment, else the language's email, else the Default), and you can send any segment the email of another, for example the UAE-en email to SA-en too.</p>
          {mode === 'copies' && canEdit && (
            <label>New versions start as a copy of
              <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>{copyFromOptions}</select>
            </label>
          )}

          {mode === 'conditions' && languageField && (
            <>
              <h3>The email for each language</h3>
              <div className="note-box" data-testid="email-kinds">
                <p className="small"><strong>Language default email</strong> (for example "ar default email"): holds all the possible blocks for every segment of the language, with no rules set. <strong>Language dynamic email</strong> (for example "ar dynamic email"): the same email once rules are set against one or more of its blocks, so each segment sees only its blocks.</p>
                <p className="small"><strong>The overall Default email is the English email</strong>, called "{defaultEmailName(content)} email". Contacts whose language has no email of its own get it, and English contacts use it, so English needs no email of its own.</p>
              </div>
              {found.size === 0 && <p className="muted">No languages yet. Build the test audience above, or type a language below.</p>}
              {found.size > 0 && (
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>{lang}</th><th>Contacts</th><th>Email</th><th></th></tr></thead>
                    <tbody>
                      {[...found.entries()].map(([k, l]) => {
                        const own = languages.find((x) => x.key === segmentKey([languageField], [l.value]));
                        const isEnglish = !own && l.value.toLowerCase() === 'en';
                        const v = own ?? (isEnglish ? content : undefined);
                        return (
                          <tr key={k}>
                            <td><strong>{l.value}</strong></td>
                            <td>{l.contacts}</td>
                            <td>{own ? <span className="ok">{versionName(own)} email <span className="muted small">· {own.blocks.length} block{own.blocks.length === 1 ? '' : 's'}</span></span> : isEnglish ? <span className="ok">{defaultEmailName(content)} email <span className="muted small">· the Default email</span></span> : null}</td>
                            <td>
                              {v && <button type="button" className="link" aria-label={`${canEdit ? 'Edit' : 'View'} the ${l.value} default`} onClick={() => { setEditing(own ? own.id : null); onOpenVersion(); }}>{canEdit ? 'Edit' : 'View'}</button>}
                              {own && canEdit && <button type="button" className="link danger" aria-label={`Delete the ${l.value} default`} onClick={() => { if (window.confirm(`Delete the email for ${l.value}? Its segments will get the Default email.`)) removeVariant(own.id); }}>Delete</button>}
                              {!v && canEdit && (
                                <select aria-label={`Create the email for ${l.value}`} value="__" onChange={(e) => { if (e.target.value !== '__') createLanguage(l.value, e.target.value); }}>
                                  <option value="__">Create as a copy of…</option>
                                  {copyFromOptions}
                                </select>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {canEdit && (
                <div className="inline-form">
                  <div><label htmlFor="typed-language">Another language <span className="muted small">(several separated by commas)</span></label><input id="typed-language" value={typedLanguage} onChange={(e) => setTypedLanguage(e.target.value)} placeholder="e.g. fr, de" /></div>
                  <div><label htmlFor="typed-language-from">Create as a copy of</label><select id="typed-language-from" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>{copyFromOptions}</select></div>
                  <div className="inline-form-actions"><button type="button" disabled={!typedLanguage.trim()} onClick={() => void createTypedLanguage()}>Create this email</button></div>
                </div>
              )}
            </>
          )}

          <h3>Segments &amp; Email Mapping</h3>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Segment</th><th>Contacts</th><th>Email it receives</th>{mode === 'copies' && <th></th>}</tr></thead>
              <tbody>
                <tr><td><strong>Everyone else</strong></td><td className="muted small">no segment</td><td>{mode === 'conditions' ? `${defaultEmailName(content)} email` : 'Default email'}</td>{mode === 'copies' && <td><button type="button" className="link" onClick={() => { setEditing(null); onOpenVersion(); }}>Edit</button></td>}</tr>
                {rowList.map((r) => {
                  const own = mode === 'copies' ? copies.find((v) => v.key === r.key) : undefined;
                  const code = own ? variantCode(own) : r.code;
                  return (
                    <tr key={r.key}>
                      <td><strong>{code}</strong>{!r.hasTest && <div className="muted small">{r.samples === null && mode === 'conditions' ? 'no test contact possible (an earlier rule always wins)' : 'no test contact yet'}</div>}</td>
                      <td>{r.total !== undefined ? `${r.total} (${r.eligible} eligible)` : <span className="muted small">{r.hasTest ? 'test contact only' : '—'}</span>}</td>
                      {emailCell(r)}
                      {mode === 'copies' && (
                        <td>
                          {own && <button type="button" className="link" aria-label={`${canEdit ? 'Edit' : 'View'} the ${code} version`} onClick={() => { setEditing(own.id); onOpenVersion(); }}>{canEdit ? 'Edit' : 'View'}</button>}
                          {own && canEdit && <button type="button" className="link danger" aria-label={`Delete the ${code} version`} onClick={() => { if (window.confirm(`Delete the ${code} version of this email? Its contacts will get the Default email.`)) removeVariant(own.id); }}>Delete</button>}
                          {!own && canEdit && <button type="button" className="link" aria-label={`Create a version for ${code}`} onClick={() => createCopy(r.values)}>Create version</button>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {tooMany && <p className="error" role="alert">There are more than 2000 segments, so the list is cut short. Use fewer values in your rules.</p>}
          {mode === 'conditions' && <p className="muted small">These segments come from the rules on your blocks. Each comparison has a short name: "UAE" (is), "not UAE", "has ua" (contains), "no ua" (does not contain), "over 10" and "under 10" (numbers), "after 2025-01-01" and "before 2025-01-01" (dates), "blank" and "filled". A contact belongs to the first one it meets, and "Default" means none of them, so "Default-en" is English contacts in any other case. Test contacts for these segments are made for you.</p>}

          {mode === 'copies' && canEdit && (
            <>
              <p className="small" style={{ marginTop: 12 }}><strong>Another segment.</strong> Type one value for each field to write a separate copy for a segment that is not in the list yet. Its test contact is made too.</p>
              <div className="map-grid">
                {chosenFields.map((f) => (
                  <label key={f.key}>{plainLabel(f.label)}
                    <input aria-label={`Version value for ${plainLabel(f.label)}`} value={typed[f.key] ?? ''} onChange={(e) => setTyped({ ...typed, [f.key]: e.target.value })} />
                  </label>
                ))}
              </div>
              <p><button type="button" disabled={chosenFields.some((f) => !(typed[f.key] ?? '').trim())} onClick={() => void createTyped()}>Create this version</button></p>
            </>
          )}
          {unused.length > 0 && (
            <details>
              <summary>{unused.length} version{unused.length > 1 ? 's' : ''} not used now</summary>
              <p className="muted small">These were made for other segment fields or the other way of building versions. They are kept, and used again if you choose the same settings. Contacts get another email meanwhile.</p>
              <ul>{unused.map((v) => <li key={v.id}><strong>{versionName(v)}</strong> <span className="muted small">({v.fields.join(', ')})</span> {canEdit && <button type="button" className="link danger" onClick={() => { if (window.confirm('Delete this version?')) removeVariant(v.id); }}>Delete</button>}</li>)}</ul>
            </details>
          )}
        </section>
      )}

      {!noChoice && (
        <div className="seg-next"><button type="button" className="primary" data-testid="segments-next" onClick={onContinue}>Next →</button></div>
      )}
    </div>
  );
}
