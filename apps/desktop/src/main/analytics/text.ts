import { en } from '@aio/ui/i18n/en';

/** The `detect.preset.*` text from the catalogue, with its `{name}` placeholders filled. */
export function presetText(
  key: Extract<keyof typeof en, `detect.preset.${string}`>,
  vars: Record<string, string | number> = {},
): string {
  return en[key].replace(/\{(\w+)\}/g, (whole, n: string) => (n in vars ? String(vars[n]) : whole));
}
