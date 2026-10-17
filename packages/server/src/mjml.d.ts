declare module 'mjml' {
  type MjmlError = { message?: string; formattedMessage?: string };
  const mjml2html: (input: string, options?: Record<string, unknown>) => Promise<{ html: string; errors: MjmlError[] }>;
  export default mjml2html;
}
