// Block library definitions (the "originals"). These are never edited by users:
// dropping a block into an email copies its defaults into an independent instance.
// Changing a definition in a released version requires a new `version`.

export type PropValue = string | number | boolean;
export type Props = Record<string, PropValue>;

export const BLOCK_TYPES = [
  'header',
  'hero',
  'text',
  'image',
  'button',
  'two_column',
  'divider',
  'spacer',
  'social',
  'footer',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export type FieldKind = 'text' | 'textarea' | 'url' | 'image' | 'color' | 'select' | 'number' | 'toggle';
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

export type BlockDefinition = {
  type: BlockType;
  version: number;
  label: string;
  description: string;
  category: 'shared';
  fields: FieldDef[];
  defaults: Props;
};

const ALIGN = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

const text = (key: string, label: string, group: FieldGroup = 'content', help?: string, max = 200): FieldDef => ({ key, label, kind: 'text', group, help, max });
const area = (key: string, label: string, max = 2000): FieldDef => ({ key, label, kind: 'textarea', group: 'content', max });
const url = (key: string, label: string, help?: string): FieldDef => ({ key, label, kind: 'url', group: 'content', help });
export const ALIAS_HELP = 'Internal name for this link, used in reports and checks. Recipients never see it.';
export const aliasKey = (urlKey: string): string => `${urlKey}Alias`;
/** A link: its address plus an internal alias. */
const link = (key: string, label: string, help?: string): FieldDef[] => [
  url(key, label, help),
  { key: aliasKey(key), label: `${label} alias`, kind: 'text', group: 'content', help: ALIAS_HELP, max: 80, optional: true },
];
const image = (key: string, label: string, help?: string): FieldDef => ({ key, label, kind: 'image', group: 'content', help });
const color = (key: string, label: string): FieldDef => ({ key, label, kind: 'color', group: 'style' });
const align = (key = 'align', label = 'Alignment'): FieldDef => ({ key, label, kind: 'select', group: 'style', options: ALIGN });
const num = (key: string, label: string, min: number, max: number, group: FieldGroup = 'spacing', unit = 'px'): FieldDef => ({ key, label, kind: 'number', group, min, max, unit });
const toggle = (key: string, label: string, group: FieldGroup = 'content'): FieldDef => ({ key, label, kind: 'toggle', group });

export const DEFAULT_ADDRESS = 'Dubai Silicon Oasis - pineapple tower G101 - Dubai - United Arab Emirates';

export const BLOCK_DEFINITIONS: BlockDefinition[] = [
  {
    type: 'header',
    version: 2,
    label: 'Header / logo',
    description: 'Logo or brand name at the top of the email.',
    category: 'shared',
    fields: [
      image('logoUrl', 'Logo image', 'Leave empty to show the brand name as text.'),
      text('logoAlt', 'Logo description (alt text)'),
      num('logoWidth', 'Logo width', 40, 400, 'style'),
      text('brandName', 'Brand name (shown when there is no logo)'),
      ...link('linkUrl', 'Link when clicked'),
      align(),
      color('bgColor', 'Background color'),
      color('textColor', 'Text color'),
      num('paddingY', 'Space above and below', 0, 80),
    ],
    defaults: { logoUrl: '', logoAlt: 'Company logo', logoWidth: 140, brandName: 'Your Brand', linkUrl: '', linkUrlAlias: 'Header link', align: 'center', bgColor: '#ffffff', textColor: '#1c2430', paddingY: 20 },
  },
  {
    type: 'hero',
    version: 2,
    label: 'Hero banner',
    description: 'Large image with a headline and a button.',
    category: 'shared',
    fields: [
      image('imageUrl', 'Banner image', 'Leave empty for a text-only banner.'),
      text('imageAlt', 'Image description (alt text)'),
      text('headline', 'Headline'),
      text('subheadline', 'Subheadline', 'content', undefined, 300),
      text('buttonText', 'Button text'),
      ...link('buttonUrl', 'Button link'),
      align(),
      color('bgColor', 'Background color'),
      color('textColor', 'Text color'),
      color('buttonColor', 'Button color'),
      color('buttonTextColor', 'Button text color'),
      num('paddingY', 'Space above and below text', 0, 100),
    ],
    defaults: {
      imageUrl: '', imageAlt: '', headline: 'A big, clear headline', subheadline: 'One supporting sentence that tells readers why it matters.',
      buttonText: 'Learn more', buttonUrl: '', buttonUrlAlias: 'Hero button', align: 'center', bgColor: '#1c2430', textColor: '#ffffff', buttonColor: '#f5b301', buttonTextColor: '#1c2430', paddingY: 40,
    },
  },
  {
    type: 'text',
    version: 1,
    label: 'Text',
    description: 'A heading and a paragraph of text.',
    category: 'shared',
    fields: [
      text('heading', 'Heading'),
      area('body', 'Text'),
      align(),
      num('fontSize', 'Text size', 12, 28, 'style'),
      color('textColor', 'Text color'),
      color('bgColor', 'Background color'),
      num('paddingY', 'Space above and below', 0, 80),
      num('paddingX', 'Space left and right', 0, 80),
    ],
    defaults: { heading: 'Section heading', body: 'Write your message here. Keep it short and friendly.', align: 'left', fontSize: 16, textColor: '#1c2430', bgColor: '#ffffff', paddingY: 24, paddingX: 24 },
  },
  {
    type: 'image',
    version: 2,
    label: 'Image',
    description: 'A single picture, optionally linked.',
    category: 'shared',
    fields: [
      image('src', 'Image'),
      text('alt', 'Image description (alt text)', 'content', 'Describe the picture for people who cannot see it.'),
      toggle('decorative', 'Decorative only (no description needed)'),
      ...link('linkUrl', 'Link when clicked'),
      num('widthPercent', 'Width', 20, 100, 'style', '%'),
      align(),
      color('bgColor', 'Background color'),
      num('paddingY', 'Space above and below', 0, 80),
    ],
    defaults: { src: '', alt: '', decorative: false, linkUrl: '', linkUrlAlias: 'Image link', widthPercent: 100, align: 'center', bgColor: '#ffffff', paddingY: 0 },
  },
  {
    type: 'button',
    version: 2,
    label: 'Button',
    description: 'A call-to-action button.',
    category: 'shared',
    fields: [
      text('label', 'Button text'),
      ...link('url', 'Link'),
      toggle('fullWidth', 'Full width'),
      align(),
      color('bgColor', 'Button color'),
      color('textColor', 'Text color'),
      color('containerBg', 'Background behind button'),
      num('borderRadius', 'Corner roundness', 0, 40, 'style'),
      num('paddingY', 'Space above and below', 0, 80),
    ],
    defaults: { label: 'Click here', url: '', urlAlias: 'Button', fullWidth: false, align: 'center', bgColor: '#2457d6', textColor: '#ffffff', containerBg: '#ffffff', borderRadius: 6, paddingY: 20 },
  },
  {
    type: 'two_column',
    version: 2,
    label: 'Two columns',
    description: 'Two side-by-side items that stack on phones.',
    category: 'shared',
    fields: [
      image('leftImage', 'Left image'),
      text('leftImageAlt', 'Left image description (alt text)'),
      text('leftHeading', 'Left heading'),
      area('leftBody', 'Left text', 600),
      text('leftButtonText', 'Left button text'),
      ...link('leftButtonUrl', 'Left button link'),
      image('rightImage', 'Right image'),
      text('rightImageAlt', 'Right image description (alt text)'),
      text('rightHeading', 'Right heading'),
      area('rightBody', 'Right text', 600),
      text('rightButtonText', 'Right button text'),
      ...link('rightButtonUrl', 'Right button link'),
      color('bgColor', 'Background color'),
      color('textColor', 'Text color'),
      color('buttonColor', 'Button color'),
      color('buttonTextColor', 'Button text color'),
      num('paddingY', 'Space above and below', 0, 80),
    ],
    defaults: {
      leftImage: '', leftImageAlt: '', leftHeading: 'First item', leftBody: 'A short description of the first item.', leftButtonText: 'Read more', leftButtonUrl: '', leftButtonUrlAlias: 'Left button',
      rightImage: '', rightImageAlt: '', rightHeading: 'Second item', rightBody: 'A short description of the second item.', rightButtonText: 'Read more', rightButtonUrl: '', rightButtonUrlAlias: 'Right button',
      bgColor: '#ffffff', textColor: '#1c2430', buttonColor: '#2457d6', buttonTextColor: '#ffffff', paddingY: 24,
    },
  },
  {
    type: 'divider',
    version: 1,
    label: 'Divider',
    description: 'A thin line between sections.',
    category: 'shared',
    fields: [color('color', 'Line color'), num('thickness', 'Thickness', 1, 8, 'style'), num('widthPercent', 'Width', 10, 100, 'style', '%'), num('paddingY', 'Space above and below', 0, 80)],
    defaults: { color: '#d9dee6', thickness: 1, widthPercent: 100, paddingY: 16 },
  },
  {
    type: 'spacer',
    version: 1,
    label: 'Spacer',
    description: 'Empty vertical space.',
    category: 'shared',
    fields: [num('height', 'Height', 4, 200)],
    defaults: { height: 24 },
  },
  {
    type: 'social',
    version: 2,
    label: 'Social links',
    description: 'Links to your social profiles. Empty links are hidden.',
    category: 'shared',
    fields: [
      ...link('facebook', 'Facebook'),
      ...link('instagram', 'Instagram'),
      ...link('x', 'X'),
      ...link('linkedin', 'LinkedIn'),
      ...link('youtube', 'YouTube'),
      align(),
      color('textColor', 'Link color'),
      color('bgColor', 'Background color'),
      num('paddingY', 'Space above and below', 0, 80),
    ],
    defaults: { facebook: '', facebookAlias: 'Social - Facebook', instagram: '', instagramAlias: 'Social - Instagram', x: '', xAlias: 'Social - X', linkedin: '', linkedinAlias: 'Social - LinkedIn', youtube: '', youtubeAlias: 'Social - YouTube', align: 'center', textColor: '#2457d6', bgColor: '#ffffff', paddingY: 16 },
  },
  {
    type: 'footer',
    version: 2,
    label: 'Footer',
    description: 'Company address and the unsubscribe link every email needs.',
    category: 'shared',
    fields: [
      text('companyName', 'Company name'),
      text('address', 'Postal address', 'content', undefined, 300),
      area('notice', 'Why they receive this email', 400),
      text('unsubscribeText', 'Unsubscribe link text'),
      ...link('unsubscribeUrl', 'Unsubscribe link', 'Keep {{unsubscribe_url}} so each recipient gets their own link when sending.'),
      align(),
      color('textColor', 'Text color'),
      color('linkColor', 'Link color'),
      color('bgColor', 'Background color'),
      num('paddingY', 'Space above and below', 0, 80),
    ],
    defaults: {
      companyName: 'Your Company', address: DEFAULT_ADDRESS, notice: 'You are receiving this email because you subscribed to our updates.',
      unsubscribeText: 'Unsubscribe', unsubscribeUrl: '{{unsubscribe_url}}', unsubscribeUrlAlias: 'Unsubscribe', align: 'center', textColor: '#5b6676', linkColor: '#2457d6', bgColor: '#f2f2f2', paddingY: 24,
    },
  },
];

export const blockDefinition = (type: string): BlockDefinition | undefined => BLOCK_DEFINITIONS.find((d) => d.type === type);
