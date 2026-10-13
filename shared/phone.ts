/**
 * Phone numbers are stored as typed. These helpers read one for display and
 * dialing: a readable form, the E.164 form for tel: links (+18165551234), and
 * any extension, which is shown but not dialed. A number without a country
 * code is taken to be in the US.
 */

export interface ParsedPhone {
  /** "(816) 555-1234", or the international number as typed with a +. */
  display: string;
  /** "+18165551234", for a tel: link. */
  e164: string;
  /** "204" from "x204" or "ext. 204"; null when there is none. */
  ext: string | null;
}

const EXTENSION = /\s*(?:,|;|#|x|ext\.?|extn\.?|extension)\s*(\d{1,6})\s*$/i;

/** Null when the value can't be read as a phone number. */
export function parsePhone(raw: string | null | undefined): ParsedPhone | null {
  if (!raw) return null;
  let main = raw.trim();
  let ext: string | null = null;
  const found = EXTENSION.exec(main);
  if (found) {
    ext = found[1];
    main = main.slice(0, found.index).trim();
  }
  // Only digits and the usual punctuation; anything else isn't a number.
  if (!/^\+?[\d\s().\-/]+$/.test(main)) return null;
  const international = main.startsWith("+");
  const digits = main.replace(/\D/g, "");

  if (!international || digits.startsWith("1")) {
    const national =
      digits.length === 10
        ? digits
        : digits.length === 11 && digits.startsWith("1")
          ? digits.slice(1)
          : null;
    // North American numbers never start with 0 or 1 in the area code or exchange.
    if (national && /^[2-9]\d{2}[2-9]\d{6}$/.test(national)) {
      return {
        display: `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`,
        e164: `+1${national}`,
        ext,
      };
    }
    if (!international) return null;
  }
  // Elsewhere: E.164 allows up to 15 digits; shorter than 8 is not a full number.
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  return { display: main.replace(/\s+/g, " "), e164: `+${digits}`, ext };
}

/** The readable form, with the extension; the stored value when it can't be read. */
export function formatPhoneNumber(raw: string | null | undefined): string {
  if (!raw) return "";
  const phone = parsePhone(raw);
  if (!phone) return raw.trim();
  return phone.ext ? `${phone.display} ext. ${phone.ext}` : phone.display;
}
