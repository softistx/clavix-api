/** Text safe to put in an HTML body or attribute: `& < > " '` become numeric references. */
export const htmlEscape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
