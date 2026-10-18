// Field descriptions shared by every block definition (what a person can edit in the right-hand panel).

export type PropValue = string | number | boolean;
export type Props = Record<string, PropValue>;

export type FieldKind = 'text' | 'textarea' | 'url' | 'image' | 'select' | 'number' | 'toggle';
export type FieldGroup = 'content' | 'style' | 'spacing';

export type FieldDef = {
  key: string;
  label: string;
  kind: FieldKind;
  group: FieldGroup;
  help?: string;
  options?: { value: string; label: string }[]; // select
  min?: number; // number
  max?: number; // number, or max length for text
  unit?: string; // number
  optional?: boolean; // may be absent in emails saved before the field existed
};

export type RawDefinition = {
  type: string;
  version: number;
  label: string;
  description: string;
  category: 'shared' | 'travel' | 'events' | 'cosmetics';
  fields: FieldDef[];
  defaults: Props;
};

const ALIGN = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

export const text = (key: string, label: string, group: FieldGroup = 'content', help?: string, max = 200): FieldDef => ({ key, label, kind: 'text', group, help, max });
export const area = (key: string, label: string, max = 2000): FieldDef => ({ key, label, kind: 'textarea', group: 'content', max });
export const url = (key: string, label: string, help?: string): FieldDef => ({ key, label, kind: 'url', group: 'content', help });
export const ALIAS_HELP = 'Internal name for this link, used in reports and checks. Recipients never see it.';
export const aliasKey = (urlKey: string): string => `${urlKey}Alias`;
/** A link: its address plus an internal alias. */
export const link = (key: string, label: string, help?: string): FieldDef[] => [
  url(key, label, help),
  { key: aliasKey(key), label: `${label} alias`, kind: 'text', group: 'content', help: ALIAS_HELP, max: 80, optional: true },
];
export const image = (key: string, label: string, help?: string): FieldDef => ({ key, label, kind: 'image', group: 'content', help });
export const align = (key = 'align', label = 'Alignment'): FieldDef => ({ key, label, kind: 'select', group: 'style', options: ALIGN });
export const num = (key: string, label: string, min: number, max: number, group: FieldGroup = 'spacing', unit = 'px'): FieldDef => ({ key, label, kind: 'number', group, min, max, unit });
export const toggle = (key: string, label: string, group: FieldGroup = 'content'): FieldDef => ({ key, label, kind: 'toggle', group });
